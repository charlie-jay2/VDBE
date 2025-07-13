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

const matchmakingQueues = new Map();

function findOpponentSocket(ws) {
  if (!ws.opponent) return null;
  for (const client of wss.clients) {
    if (
      client !== ws &&
      client.user &&
      client.user.username === ws.opponent &&
      client.readyState === WebSocket.OPEN
    ) {
      return client;
    }
  }
  return null;
}

// 💓 Heartbeat (keep sockets alive)
function heartbeat() {
  this.isAlive = true;
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

  try {
    const user = jwt.verify(token, JWT_SECRET);
    ws.user = user;
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    ws.close(1008, "Invalid token");
    return;
  }

  ws.rarity = null;
  ws.opponent = null;

  ws.send(
    JSON.stringify({
      type: "welcome",
      message: `👋 Welcome ${ws.user.username}#${ws.user.discriminator}`,
    })
  );

  console.log(
    `🔗 New connection: ${ws.user.username}#${ws.user.discriminator}`
  );

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

        player1.opponent = player2.user.username;
        player2.opponent = player1.user.username;

        player1.role = "Player One";
        player2.role = "Player Two";

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
      if (opponentSocket) {
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
      }
    }
  });

  ws.on("close", () => {
    console.log(`🔌 Disconnected: ${ws.user.username}`);

    if (ws.rarity && matchmakingQueues.has(ws.rarity)) {
      const queue = matchmakingQueues.get(ws.rarity);
      const index = queue.indexOf(ws);
      if (index !== -1) queue.splice(index, 1);
      console.log(
        `📤 Removed ${ws.user.username} from queue (rarity: ${ws.rarity})`
      );
    }

    if (ws.opponent) {
      const opponentSocket = findOpponentSocket(ws);
      if (opponentSocket) {
        console.log(
          `⚠️ Notifying ${opponentSocket.user.username} that opponent disconnected`
        );
        opponentSocket.send(
          JSON.stringify({
            type: "status",
            message: "⚠️ Your opponent disconnected. Waiting to reconnect...",
          })
        );
        // Do NOT clear opponentSocket.opponent so they can reconnect
      }
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
