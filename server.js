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

const CARD_STATS = {
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

function findCardStats(cardName) {
  for (const [rarity, cards] of Object.entries(CARD_STATS)) {
    if (cards[cardName]) {
      return { ...cards[cardName], rarity };
    }
  }
  return null;
}

const matchmakingQueues = new Map();
const matches = new Map();
const playerStates = new Map();

function findOpponentSocket(ws) {
  const opponent = matches.get(ws.user.username);
  if (!opponent || opponent.readyState !== WebSocket.OPEN) return null;
  return opponent;
}

function heartbeat() {
  this.isAlive = true;
}

function clearDisconnectTimer(username) {
  const state = playerStates.get(username);
  if (state?.disconnectTimeout) {
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
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ""));
  const token = urlParams.get("token");
  if (!token) return ws.close(1008, "Unauthorized");

  try {
    ws.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return ws.close(1008, "Invalid token");
  }

  const prevState = playerStates.get(ws.user.username);
  if (prevState && !prevState.isConnected) {
    clearDisconnectTimer(ws.user.username);
    prevState.socket = ws;
    prevState.isConnected = true;

    const opponentSocket = matches.get(ws.user.username);
    if (opponentSocket) {
      matches.set(opponentSocket.user.username, ws);
      playerStates.get(opponentSocket.user.username).socket = opponentSocket;

      opponentSocket.send(
        JSON.stringify({
          type: "status",
          message: `✅ Your opponent ${ws.user.username} reconnected.`,
        })
      );
    }

    ws.send(
      JSON.stringify({
        type: "status",
        message: `✅ Reconnected to match.`,
      })
    );
  } else {
    playerStates.set(ws.user.username, {
      socket: ws,
      isConnected: true,
      disconnectTimeout: null,
    });

    ws.send(
      JSON.stringify({
        type: "welcome",
        message: `👋 Welcome ${ws.user.username}`,
      })
    );
  }

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === "join") {
      const rarity = data.rarity || "Unknown";
      ws.rarity = rarity;

      if (!matchmakingQueues.has(rarity)) matchmakingQueues.set(rarity, []);
      const queue = matchmakingQueues.get(rarity);
      queue.push(ws);

      if (queue.length >= 2) {
        const [player1, player2] = queue.splice(0, 2);

        player1.role = "Player One";
        player2.role = "Player Two";

        matches.set(player1.user.username, player2);
        matches.set(player2.user.username, player1);

        playerStates.set(player1.user.username, {
          socket: player1,
          isConnected: true,
          disconnectTimeout: null,
        });
        playerStates.set(player2.user.username, {
          socket: player2,
          isConnected: true,
          disconnectTimeout: null,
        });

        player1.send(
          JSON.stringify({
            type: "matched",
            opponent: player2.user.username,
            role: player1.role,
          })
        );
        player2.send(
          JSON.stringify({
            type: "matched",
            opponent: player1.user.username,
            role: player2.role,
          })
        );
      }
    } else if (data.type === "selection") {
      const cardName = data.cardName;
      if (!cardName) return;

      const playerStats = findCardStats(cardName);
      if (!playerStats) {
        return ws.send(
          JSON.stringify({
            type: "error",
            message: "Card not found in database.",
          })
        );
      }

      const opponentSocket = findOpponentSocket(ws);
      if (!opponentSocket) {
        return ws.send(
          JSON.stringify({
            type: "status",
            message: "⚠️ Opponent not connected.",
          })
        );
      }

      const opponentCard = data.opponentCard || null;
      let analysis = null;

      if (opponentCard) {
        const opponentStats = findCardStats(opponentCard);
        if (opponentStats) {
          const spDiff = playerStats.SP - opponentStats.SP;
          const vrDiff = playerStats.VR - opponentStats.VR;
          analysis = {
            spDifference: spDiff,
            vrDifference: vrDiff,
            summary: `You have ${spDiff > 0 ? "+" : ""}${spDiff} SP and ${
              vrDiff > 0 ? "+" : ""
            }${vrDiff} VR vs opponent.`,
          };
        }
      }

      opponentSocket.send(
        JSON.stringify({
          type: "opponentSelection",
          username: ws.user.username,
          cardName,
          stats: {
            SongPower: playerStats.SP,
            VocalRange: playerStats.VR,
            rarity: playerStats.rarity,
          },
          analysis,
        })
      );
    }
  });

  ws.on("close", () => {
    const username = ws.user.username;
    const state = playerStates.get(username);
    if (!state) return;
    state.isConnected = false;

    state.disconnectTimeout = setTimeout(() => {
      for (const [rarity, queue] of matchmakingQueues.entries()) {
        const index = queue.indexOf(ws);
        if (index !== -1) queue.splice(index, 1);
      }
      cleanupMatch(username);
      playerStates.delete(username);
    }, 60000);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
