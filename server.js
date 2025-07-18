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

// Validate essential environment variables on startup
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

// Middleware Setup
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS for frontend access
app.use(express.json()); // Parse JSON bodies

/**
 * ============================
 * OAuth2 Discord Authentication
 * ============================
 */
app.get("/auth/discord", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code provided");

  try {
    // Exchange authorization code for access token
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

    // Fetch user info from Discord API
    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userResponse.data;

    // Create JWT payload and sign token for client
    const jwtPayload = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
    };

    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "7d" });

    console.log(`✅ Authenticated: ${user.username}#${user.discriminator}`);

    // Redirect back to frontend with JWT token in query params
    res.redirect(`${FRONTEND_URL}?token=${token}`);
  } catch (err) {
    console.error(
      "❌ Discord OAuth failed:",
      err.response?.data || err.message
    );
    res.status(500).send("Discord authentication failed");
  }
});

/**
 * ====================
 * Card Stats Constants
 * ====================
 * These represent the stats for each card per rarity.
 * In a real game, these might come from a DB or external service.
 */
const CARD_STATS = {
  r1: {
    // Common cards
    "r1Kagamine Rin C": { SP: 20, VR: 15 },
    "r1Kagamine Len C": { SP: 20, VR: 20 },
    "r1Meiko C": { SP: 14, VR: 20 },
    "r1Kaito C": { SP: 10, VR: 20 },
    "r1Magurine Luka C": { SP: 18, VR: 20 },
    "r1Yowane Haku C": { SP: 18, VR: 20 },
  },
  r2: {
    // Extra rarity cards
    "r2Hatsune Miku E": { SP: 25, VR: 25 },
    "r2Gumi E": { SP: 30, VR: 25 },
    "r2Kagumine Rin E": { SP: 34, VR: 15 },
    "r2Flower E": { SP: 35, VR: 30 },
    "r2Tohoko E": { SP: 30, VR: 40 },
    "r2Meiko E": { SP: 24, VR: 20 },
    "r2Kagurime Len E": { SP: 35, VR: 20 },
    "r2Magurine Luka E": { SP: 27, VR: 20 },
    "r2Kaito E": { SP: 30, VR: 20 },
    "r2Anon & Kanon E": { SP: 28, VR: 20 },
  },
  r3: {
    // Rare cards
    "r3Hatsune Miku R": { SP: 40, VR: 25 },
    "r3Gumi R": { SP: 45, VR: 25 },
    "r3Rana R": { SP: 40, VR: 25 },
    "r3Tohoko R": { SP: 42, VR: 40 },
    "r3Macne Nana R": { SP: 48, VR: 10 },
    "r3Magurine Luka R": { SP: 48, VR: 20 },
    "r3Kasane Teto R": { SP: 45, VR: 35 },
    "r3Anon & Kanon R": { SP: 38, VR: 20 },
    "r3Akoi Lapis R": { SP: 48, VR: 20 },
    "r3Mikudayo R": { SP: 40, VR: 30 },
    "r3Cherry Mikudayo R": { SP: 50, VR: 30 },
    "r3Defoko R": { SP: 45, VR: 20 },
  },
  r4: {
    // Legendary cards
    "r4Gumi L": { SP: 64, VR: 25 },
    "r4Rana L": { SP: 75, VR: 25 },
    "r4Galaco L": { SP: 80, VR: 30 },
    "r4Macne Nana L": { SP: 78, VR: 10 },
    "r4Akita Neru L": { SP: 65, VR: 30 },
    "r4Kaai Yuki L": { SP: 80, VR: 20 },
    "r4Kasane Teto L": { SP: 78, VR: 35 },
    "r4Kokone L": { SP: 80, VR: 45 },
    "r4Defoko L": { SP: 70, VR: 20 },
    "r4Momone L": { SP: 72, VR: 15 },
  },
  r5: {
    // Untouched rarity cards
    "r5Rana U": { SP: 87, VR: 20 },
    "r5Galaco U": { SP: 97, VR: 30 },
    "r5Kasane Teto U": { SP: 95, VR: 35 },
    "r5CaseO U": { SP: 98, VR: 20 },
    "r5Kokone U": { SP: 100, VR: 45 },
    "r5Momone U": { SP: 94, VR: 15 },
  },
};

// Serve the index.html at root
app.use(express.static(path.join(__dirname, "public")));

// Endpoint to return all active matches data
app.get("/matches", (req, res) => {
  // Build an array of match info objects { playerOne, rarity, playerTwo }
  const seen = new Set();
  const matchList = [];

  for (const [player, opponentWs] of matches.entries()) {
    if (seen.has(player)) continue; // Already processed
    const opponent = opponentWs.user.username;

    // Only include if opponent also matches back
    if (
      matches.get(opponent) &&
      matches.get(opponent).user.username === player
    ) {
      // Get rarity from one of the players' sockets
      const playerOneSocket = playerStates.get(player)?.socket;
      const rarity = playerOneSocket?.rarity || "N/A";

      matchList.push({
        playerOne: player,
        rarity,
        playerTwo: opponent,
      });

      seen.add(player);
      seen.add(opponent);
    }
  }

  res.json(matchList);
});

/**
 * =====================================
 * Matchmaking, Matches and Player States
 * =====================================
 */
// Map rarity string => array of WebSocket clients waiting
const matchmakingQueues = new Map();

// Map username => opponent's WebSocket
const matches = new Map();

// Map username => player state object { socket, isConnected, disconnectTimeout }
const playerStates = new Map();

/**
 * Helper function:
 * Finds the opponent socket of the given player's socket
 */
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

/**
 * Heartbeat function for WebSocket connection health check
 */
function heartbeat() {
  this.isAlive = true;
}

/**
 * Clears disconnect timeout for a player if set
 */
function clearDisconnectTimer(username) {
  const state = playerStates.get(username);
  if (state && state.disconnectTimeout) {
    clearTimeout(state.disconnectTimeout);
    state.disconnectTimeout = null;
  }
}

/**
 * Cleanup function for when a player disconnects or match ends
 */
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

/**
 * ===========================
 * WebSocket Connection Handler
 * ===========================
 */
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // Extract JWT token from query parameters
  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ""));
  const token = urlParams.get("token");

  if (!token) {
    console.warn("❌ No token provided in query params");
    ws.close(1008, "Unauthorized");
    return;
  }

  let user;
  try {
    // Verify JWT token and attach user info to socket
    user = jwt.verify(token, JWT_SECRET);
    ws.user = user;
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    ws.close(1008, "Invalid token");
    return;
  }

  ws.rarity = null; // Player's chosen rarity queue

  /**
   * --- Reconnection Handling ---
   * If player reconnects within timeout, restore their state and notify opponent
   */
  const prevState = playerStates.get(user.username);
  if (prevState && !prevState.isConnected) {
    console.log(`🔄 Reconnection detected for ${user.username}`);

    // Cancel disconnect cleanup timer
    clearDisconnectTimer(user.username);

    // Update player state with new socket and connected flag
    prevState.socket = ws;
    prevState.isConnected = true;

    // Update matches map to point to the new socket correctly
    const opponentSocket = matches.get(user.username);
    if (opponentSocket) {
      const opponentName = opponentSocket.user.username;

      // Keep existing match pairings but update sockets
      matches.set(user.username, opponentSocket);
      matches.set(opponentName, ws);

      // Update player states with correct socket references
      const opponentState = playerStates.get(opponentName);
      if (opponentState) opponentState.socket = opponentSocket;
      const playerState = playerStates.get(user.username);
      if (playerState) playerState.socket = ws;

      console.log(
        `🔄 Updated match sockets for ${user.username} and ${opponentName}`
      );

      // Notify opponent that the player reconnected
      if (opponentSocket.readyState === WebSocket.OPEN) {
        opponentSocket.send(
          JSON.stringify({
            type: "status",
            message: `✅ Your opponent ${user.username} reconnected.`,
          })
        );
      }

      // Notify reconnecting player
      ws.send(
        JSON.stringify({
          type: "status",
          message: `✅ Reconnected to match with ${opponentName}.`,
        })
      );
    } else {
      // No active match found; just send welcome back
      ws.send(
        JSON.stringify({
          type: "welcome",
          message: `👋 Welcome back ${user.username}#${user.discriminator}`,
        })
      );
    }
  } else {
    // New connection: create a new player state
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

  /**
   * ===================
   * WebSocket Message Handler
   * ===================
   */
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      console.warn("⚠️ Non-JSON message received:", message);
      return;
    }

    console.log(`📩 Received from ${ws.user.username}:`, data);

    switch (data.type) {
      case "join":
        handleJoinQueue(ws, data);
        break;

      case "selection":
        handleCardSelection(ws, data);
        break;

      case "chat":
        handleChatMessage(ws, data);
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      default:
        console.warn(
          `⚠️ Unknown message type from ${ws.user.username}:`,
          data.type
        );
    }
  });

  /**
   * When a client disconnects:
   * - Mark player as disconnected
   * - Start cleanup timer
   * - Remove from matchmaking queue and active matches if applicable
   */
  ws.on("close", () => {
    const username = ws.user.username;
    console.log(`❌ Connection closed: ${username}`);

    // Mark player disconnected but keep state for possible reconnect
    const state = playerStates.get(username);
    if (state) {
      state.isConnected = false;

      // Start 10s timer to cleanup match if no reconnect
      state.disconnectTimeout = setTimeout(() => {
        console.log(`⏳ Player ${username} failed to reconnect in time.`);

        // Notify opponent
        const opponentSocket = matches.get(username);
        if (opponentSocket && opponentSocket.readyState === WebSocket.OPEN) {
          opponentSocket.send(
            JSON.stringify({
              type: "status",
              message: `⚠️ Your opponent ${username} disconnected.`,
            })
          );
        }

        // Clean up matchmaking queues if in one
        if (ws.rarity) {
          const queue = matchmakingQueues.get(ws.rarity);
          if (queue) {
            matchmakingQueues.set(
              ws.rarity,
              queue.filter((client) => client !== ws)
            );
          }
        }

        // Clean up matches and player state
        cleanupMatch(username);
      }, 10000);
    }
  });
});

/**
 * ==================
 * Handle "join" message
 * ==================
 * Adds player to the matchmaking queue for their chosen rarity.
 * If another player is waiting, starts a match between them.
 */
function handleJoinQueue(ws, data) {
  const rarity = data.rarity;
  if (!rarity) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Missing rarity in join request",
      })
    );
    return;
  }

  ws.rarity = rarity;

  if (!matchmakingQueues.has(rarity)) {
    matchmakingQueues.set(rarity, []);
  }

  const queue = matchmakingQueues.get(rarity);

  if (queue.length === 0) {
    // Add player to queue and wait
    queue.push(ws);
    ws.send(
      JSON.stringify({
        type: "waiting",
        message: `⏳ Waiting for opponent in ${rarity} queue...`,
      })
    );
    console.log(`📥 Added ${ws.user.username} to queue: ${rarity}`);
  } else {
    // Match found: remove first player in queue and pair them
    const opponent = queue.shift();
    if (opponent.readyState !== WebSocket.OPEN) {
      // Opponent socket closed, skip and add current player back to queue
      ws.send(
        JSON.stringify({
          type: "waiting",
          message: `⏳ Waiting for opponent in ${rarity} queue...`,
        })
      );
      queue.push(ws);
      return;
    }

    // Create bidirectional match pairing
    matches.set(ws.user.username, opponent);
    matches.set(opponent.user.username, ws);

    // Update player states
    playerStates.set(ws.user.username, {
      socket: ws,
      isConnected: true,
      disconnectTimeout: null,
    });
    playerStates.set(opponent.user.username, {
      socket: opponent,
      isConnected: true,
      disconnectTimeout: null,
    });

    // Notify both players match started
    ws.send(
      JSON.stringify({
        type: "start",
        message: `🎉 Match started against ${opponent.user.username}`,
        opponent: opponent.user.username,
      })
    );
    opponent.send(
      JSON.stringify({
        type: "start",
        message: `🎉 Match started against ${ws.user.username}`,
        opponent: ws.user.username,
      })
    );

    console.log(
      `🤝 Match started between ${ws.user.username} and ${opponent.user.username} in ${rarity}`
    );
  }
}

/**
 * ==========================
 * Handle card "selection" message
 * ==========================
 * Forwards selected card data to the opponent.
 */
function handleCardSelection(ws, data) {
  if (!matches.has(ws.user.username)) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "No active match to select cards",
      })
    );
    return;
  }

  const opponent = findOpponentSocket(ws);
  if (!opponent) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Opponent socket not found",
      })
    );
    return;
  }

  // Forward card selection data to opponent
  opponent.send(
    JSON.stringify({
      type: "selection",
      cards: data.cards,
      from: ws.user.username,
    })
  );
}

/**
 * =================
 * Handle "chat" message
 * =================
 * Relays chat messages between matched players.
 */
function handleChatMessage(ws, data) {
  if (!matches.has(ws.user.username)) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "No active match to send chat",
      })
    );
    return;
  }

  const opponent = findOpponentSocket(ws);
  if (!opponent) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Opponent socket not found",
      })
    );
    return;
  }

  if (!data.message) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Empty chat message",
      })
    );
    return;
  }

  // Forward chat message to opponent
  opponent.send(
    JSON.stringify({
      type: "chat",
      message: data.message,
      from: ws.user.username,
    })
  );
}

/**
 * ===============
 * WebSocket Ping Pong
 * ===============
 * Periodic health check for WebSocket connections.
 */
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`❌ Terminating dead socket: ${ws.user?.username}`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

/**
 * =====================
 * Express Static File Serve (Optional)
 * =====================
 * If you want to serve a frontend from this server
 */
// app.use(express.static(path.join(__dirname, "public")));

/**
 * =================
 * Server Listen
 * =================
 */
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
