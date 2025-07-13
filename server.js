import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import axios from "axios";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  FRONTEND_URL,
  PORT = 3000,
} = process.env;

if (
  !DISCORD_CLIENT_ID ||
  !DISCORD_CLIENT_SECRET ||
  !DISCORD_REDIRECT_URI ||
  !JWT_SECRET ||
  !FRONTEND_URL
) {
  console.error("❌ Missing environment variables!");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/auth/discord", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code provided");

  try {
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token } = tokenResponse.data;

    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userResponse.data;

    const jwtPayload = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
    };

    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "7d" });

    console.log(`✅ Authenticated: ${user.username}#${user.discriminator}`);

    res.redirect(`${FRONTEND_URL}?token=${token}`);
  } catch (err) {
    console.error(
      "❌ Discord OAuth failed:",
      err.response?.data || err.message
    );
    res.status(500).send("Discord authentication failed");
  }
});

// 🌟 Tracks players waiting by rarity
const matchmakingQueues = new Map();

// 🌟 Tracks active matches (username -> opponentSocket)
const matches = new Map();

// 🌟 Tracks player states for reconnect and cleanup
// Structure:
// {
//   socket: WebSocket,
//   isConnected: boolean,
//   disconnectTimeout: NodeJS.Timeout | null,
// }
const playerStates = new Map();

function findOpponentSocket(ws) {
  const opponent = matches.get(ws.user.username);
  if (!opponent) {
    console.log(`❌ No opponent found in matches for ${ws.user.username}`);
    return null;
  }
  if (opponent.readyState !== WebSocket.OPEN) {
    console.log(`❌ Opponent socket for ${ws.user.username} is not open`);
    return null;
  }
  console.log(
    `✅ Opponent socket found for ${ws.user.username}: ${opponent.user.username}`
  );
  return opponent;
}

// Mark socket alive for heartbeat
function heartbeat() {
  this.isAlive = true;
}

// Helper to clear disconnect timer if exists
function clearDisconnectTimer(username) {
  const state = playerStates.get(username);
  if (state && state.disconnectTimeout) {
    clearTimeout(state.disconnectTimeout);
    state.disconnectTimeout = null;
  }
}

// Helper to cleanup a match
function cleanupMatch(username) {
  const opponentSocket = matches.get(username);
  if (!opponentSocket) return;

  const opponentName = opponentSocket.user.username;

  matches.delete(username);
  matches.delete(opponentName);

  playerStates.delete(username);
  playerStates.delete(opponentName);

  console.log(`🗑 Cleaned up match between ${username} and ${opponentName}`);
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ""));
  const token = urlParams.get("token");

  if (!token) {
    console.warn("❌ No token provided in query params");
    ws.close(1008, "Unauthorized");
    return;
  }

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
    ws.user = user;
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    ws.close(1008, "Invalid token");
    return;
  }

  ws.rarity = null;

  // --- Reconnect handling ---
  // Check if this user has a state and a disconnected socket
  const prevState = playerStates.get(user.username);
  if (prevState && !prevState.isConnected) {
    console.log(`🔄 Reconnection detected for ${user.username}`);

    // Cancel any pending cleanup timeout for this player
    clearDisconnectTimer(user.username);

    // Update state with new socket and connected flag
    prevState.socket = ws;
    prevState.isConnected = true;

    // Update matches map to point to new socket
    const opponentSocket = matches.get(user.username);
    if (opponentSocket) {
      matches.set(user.username, ws);
      matches.set(opponentSocket.user.username, opponentSocket);
      console.log(
        `🔄 Updated match sockets for ${user.username} and ${opponentSocket.user.username}`
      );

      // Notify opponent the player has reconnected
      if (opponentSocket.readyState === WebSocket.OPEN) {
        opponentSocket.send(
          JSON.stringify({
            type: "status",
            message: `✅ Your opponent ${user.username} reconnected.`,
          })
        );
      }

      ws.send(
        JSON.stringify({
          type: "status",
          message: `✅ Reconnected to match with ${opponentSocket.user.username}.`,
        })
      );
    } else {
      // No opponent found, just welcome
      ws.send(
        JSON.stringify({
          type: "welcome",
          message: `👋 Welcome back ${user.username}#${user.discriminator}`,
        })
      );
    }
  } else {
    // New connection: add state
    playerStates.set(user.username, {
      socket: ws,
      isConnected: true,
      disconnectTimeout: null,
    });

    ws.send(
      JSON.stringify({
        type: "welcome",
        message: `👋 Welcome ${user.username}#${user.discriminator}`,
      })
    );
  }

  console.log(`🔗 Connection opened: ${user.username}#${user.discriminator}`);

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      console.warn("⚠️ Non-JSON message received:", message);
      return;
    }

    console.log(`📩 Received from ${ws.user.username}:`, data);

    if (data.type === "join") {
      const rarity = data.rarity || "Unknown";
      ws.rarity = rarity;

      if (!matchmakingQueues.has(rarity)) {
        matchmakingQueues.set(rarity, []);
      }

      const queue = matchmakingQueues.get(rarity);
      queue.push(ws);

      console.log(
        `🎯 ${ws.user.username} joined queue (rarity: ${rarity}). Queue size: ${queue.length}`
      );

      ws.send(
        JSON.stringify({
          type: "status",
          message: `Waiting for opponent of rarity: ${rarity}`,
        })
      );

      if (queue.length >= 2) {
        const [player1, player2] = queue.splice(0, 2);

        player1.role = "Player One";
        player2.role = "Player Two";

        // 👥 Save active match pairings
        matches.set(player1.user.username, player2);
        matches.set(player2.user.username, player1);

        // Initialize or update playerStates if not present (for new matches)
        if (!playerStates.has(player1.user.username)) {
          playerStates.set(player1.user.username, {
            socket: player1,
            isConnected: true,
            disconnectTimeout: null,
          });
        }
        if (!playerStates.has(player2.user.username)) {
          playerStates.set(player2.user.username, {
            socket: player2,
            isConnected: true,
            disconnectTimeout: null,
          });
        }

        player1.send(
          JSON.stringify({
            type: "matched",
            opponent: player2.user.username,
            yourName: player1.user.username,
            role: player1.role,
          })
        );
        player2.send(
          JSON.stringify({
            type: "matched",
            opponent: player1.user.username,
            yourName: player2.user.username,
            role: player2.role,
          })
        );

        console.log(
          `🔗 Matched ${player1.user.username} with ${player2.user.username} (rarity: ${rarity})`
        );
      }
    } else if (data.type === "selection") {
      const cardName = data.cardName;
      if (!cardName) {
        console.warn(`⚠️ No cardName provided by ${ws.user.username}`);
        return;
      }

      console.log(`🃏 ${ws.user.username} selected: ${cardName}`);

      const opponentSocket = findOpponentSocket(ws);
      if (opponentSocket && opponentSocket.readyState === WebSocket.OPEN) {
        console.log(
          `📡 Relaying ${ws.user.username}'s card to ${opponentSocket.user.username}`
        );
        opponentSocket.send(
          JSON.stringify({
            type: "opponentSelection",
            username: ws.user.username,
            cardName: cardName,
          })
        );
      } else {
        console.warn(`⚠️ No opponent socket found for ${ws.user.username}`);

        ws.send(
          JSON.stringify({
            type: "status",
            message: "⚠️ Your opponent is not connected currently.",
          })
        );
      }
    }
  });

  ws.on("close", () => {
    const username = ws.user.username;
    console.log(`🔌 Disconnected: ${username}`);

    // Mark as disconnected in playerStates and start 1-minute timer to cleanup
    const state = playerStates.get(username);
    if (state) {
      state.isConnected = false;
      state.disconnectTimeout = setTimeout(() => {
        // Check if both players disconnected
        const opponentSocket = matches.get(username);
        if (opponentSocket) {
          const opponentName = opponentSocket.user.username;
          const opponentState = playerStates.get(opponentName);

          if (!opponentState || opponentState.isConnected === false) {
            // Both disconnected, cleanup match
            cleanupMatch(username);
          } else {
            // Opponent still connected, do not cleanup yet
            console.log(
              `⏳ Waiting on opponent ${opponentName} to disconnect before cleanup`
            );
          }
        } else {
          // No opponent, cleanup just this player
          playerStates.delete(username);
          console.log(
            `🗑 Cleaned up player state for ${username} (no opponent)`
          );
        }
      }, 60 * 1000); // 1 minute
    }

    // Remove from matchmaking queue if present
    if (ws.rarity && matchmakingQueues.has(ws.rarity)) {
      const queue = matchmakingQueues.get(ws.rarity);
      const index = queue.indexOf(ws);
      if (index !== -1) queue.splice(index, 1);
      console.log(`📤 Removed ${username} from queue (rarity: ${ws.rarity})`);
    }

    // Notify opponent if connected that player disconnected
    const opponentSocket = matches.get(username);
    if (opponentSocket && opponentSocket.readyState === WebSocket.OPEN) {
      console.log(
        `⚠️ Notifying ${opponentSocket.user.username} that opponent disconnected`
      );
      opponentSocket.send(
        JSON.stringify({
          type: "status",
          message: "⚠️ Your opponent disconnected. Waiting to reconnect...",
        })
      );
    }
  });

  ws.on("error", (err) => {
    console.error(`❌ Error for ${ws.user.username}:`, err.message);
  });
});

// Heartbeat interval
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.warn(`💀 Terminating dead connection: ${ws.user?.username}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});
