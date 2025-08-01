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

// Card stats object:
const cardStats = {
  COMMON: {
    "Kagamine Rin": { SP: 20, VR: 15 },
    "Kagamine Len": { SP: 20, VR: 20 },
    Meiko: { SP: 14, VR: 20 },
    Kaito: { SP: 10, VR: 20 },
    "Magurine Luka": { SP: 18, VR: 20 },
    "Yowane Haku": { SP: 18, VR: 20 },
  },
  EXTRA: {
    "Hatsune Miku": { SP: 25, VR: 25 },
    Gumi: { SP: 30, VR: 25 },
    "Kagumine Rin": { SP: 34, VR: 15 },
    Flower: { SP: 35, VR: 30 },
    Tohoko: { SP: 30, VR: 40 },
    Meiko: { SP: 24, VR: 20 },
    "Kagurime Len": { SP: 35, VR: 20 },
    "Magurine Luka": { SP: 27, VR: 20 },
    Kaito: { SP: 30, VR: 20 },
    "Anon & Kanon": { SP: 28, VR: 20 },
  },
  RARE: {
    "Hatsune Miku": { SP: 40, VR: 25 },
    Gumi: { SP: 45, VR: 25 },
    Rana: { SP: 40, VR: 25 },
    Tohoko: { SP: 42, VR: 40 },
    Luka: { SP: 42, VR: 40 },
    "Macne Nana": { SP: 48, VR: 10 },
    "Magurine Luka": { SP: 48, VR: 20 },
    "Kasane Teto": { SP: 45, VR: 35 },
    "Anon & Kanon": { SP: 38, VR: 20 },
    "Akoi Lapis": { SP: 48, VR: 20 },
    Mikudayo: { SP: 40, VR: 30 },
    "Cherry Mikudayo": { SP: 50, VR: 30 },
    Defoko: { SP: 45, VR: 20 },
  },
  LEGENDARY: {
    Gumi: { SP: 64, VR: 25 },
    Rana: { SP: 75, VR: 25 },
    Galaco: { SP: 80, VR: 30 },
    "Macne Nana": { SP: 78, VR: 10 },
    "Akita Neru": { SP: 65, VR: 30 },
    "Kaai Yuki": { SP: 80, VR: 20 },
    "Kasane Teto": { SP: 78, VR: 35 },
    Kokone: { SP: 80, VR: 45 },
    Defoko: { SP: 70, VR: 20 },
    Momone: { SP: 72, VR: 15 },
  },
  UNTOUCHED: {
    Rana: { SP: 87, VR: 20 },
    Galaco: { SP: 97, VR: 30 },
    "Kasane Teto": { SP: 95, VR: 35 },
    CaseO: { SP: 98, VR: 20 },
    Kokone: { SP: 100, VR: 45 },
    Momone: { SP: 94, VR: 15 },
  },
};

// 🌟 Tracks players waiting by rarity
const matchmakingQueues = new Map();

// 🌟 Tracks active matches (username -> opponentSocket)
const matches = new Map();

// 🌟 Tracks player states for reconnect and cleanup
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

function heartbeat() {
  this.isAlive = true;
}

function clearDisconnectTimer(username) {
  const state = playerStates.get(username);
  if (state && state.disconnectTimeout) {
    clearTimeout(state.disconnectTimeout);
    state.disconnectTimeout = null;
  }
}

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

  // Reconnect handling
  const prevState = playerStates.get(user.username);
  if (prevState && !prevState.isConnected) {
    console.log(`🔄 Reconnection detected for ${user.username}`);

    clearDisconnectTimer(user.username);

    prevState.socket = ws;
    prevState.isConnected = true;

    const opponentSocket = matches.get(user.username);
    if (opponentSocket) {
      const opponentName = opponentSocket.user.username;

      matches.set(user.username, opponentSocket);
      matches.set(opponentName, ws);

      const opponentState = playerStates.get(opponentName);
      if (opponentState) opponentState.socket = opponentSocket;
      const playerState = playerStates.get(user.username);
      if (playerState) playerState.socket = ws;

      console.log(
        `🔄 Updated match sockets for ${user.username} and ${opponentName}`
      );

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
          message: `✅ Reconnected to match with ${opponentName}.`,
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "welcome",
          message: `👋 Welcome back ${user.username}#${user.discriminator}`,
        })
      );
    }
  } else {
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

        matches.set(player1.user.username, player2);
        matches.set(player2.user.username, player1);

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
    } else if (data.type === "getCardStats") {
      // Client asks for stats of a card
      const cardName = data.cardName;
      if (!cardName) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "No cardName provided for getCardStats",
          })
        );
        return;
      }

      // Find card stats in all categories
      let stats = null;
      for (const category of Object.values(cardStats)) {
        if (category[cardName]) {
          stats = category[cardName];
          break;
        }
      }

      if (stats) {
        ws.send(
          JSON.stringify({
            type: "cardStats",
            cardName: cardName,
            SP: stats.SP,
            VR: stats.VR,
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Stats not found for card: ${cardName}`,
          })
        );
      }
    }
  });

  ws.on("close", () => {
    const username = ws.user.username;
    console.log(`🔌 Connection closed: ${username}`);

    const state = playerStates.get(username);
    if (!state) {
      console.log(`⚠️ No state found on close for ${username}`);
      return;
    }

    state.isConnected = false;

    state.disconnectTimeout = setTimeout(() => {
      console.log(`⏳ Cleaning up after disconnect timeout for ${username}`);

      for (const [rarity, queue] of matchmakingQueues.entries()) {
        const index = queue.indexOf(ws);
        if (index !== -1) {
          queue.splice(index, 1);
          console.log(`🗑 Removed ${username} from queue (${rarity})`);
          break;
        }
      }

      cleanupMatch(username);

      playerStates.delete(username);

      console.log(`🧹 Cleaned up player state for ${username}`);
    }, 60000);
  });
});

// Heartbeat to detect dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`💀 Terminating dead connection: ${ws.user?.username}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
