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

// __dirname workaround for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

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

// Discord OAuth callback
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

// Helper to find opponent socket of a given client
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

// WebSocket client authentication using JWT token passed as subprotocol
function verifyClient(info, done) {
  const protocols = info.req.headers["sec-websocket-protocol"];
  if (!protocols) {
    console.warn("❌ No token provided in WebSocket protocol header");
    return done(false, 401, "Unauthorized");
  }

  const token = protocols.split(",")[0].trim();

  try {
    const user = jwt.verify(token, JWT_SECRET);
    info.req.user = user;
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
    done(true);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    done(false, 401, "Invalid token");
  }
}

server.on("upgrade", (req, socket, head) => {
  verifyClient({ req }, (auth, code, message) => {
    if (!auth) {
      socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
});

wss.on("connection", (ws, req) => {
  const user = req.user;

  ws.send(
    JSON.stringify({
      type: "welcome",
      message: `👋 Welcome ${user.username}#${user.discriminator}`,
    })
  );

  ws.user = user;
  ws.rarity = null;
  ws.opponent = null;
  ws.selection = null;

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      console.warn("Received non-JSON message:", message);
      return;
    }

    if (data.type === "join") {
      const rarity = data.rarity || "Unknown";
      ws.rarity = rarity;

      if (!matchmakingQueues.has(rarity)) {
        matchmakingQueues.set(rarity, []);
      }

      const queue = matchmakingQueues.get(rarity);
      queue.push(ws);

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

        // Mark player1 and player2 roles
        player1.role = "Player One";
        player2.role = "Player Two";

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

        console.log(
          `🔗 Matched ${player1.user.username} with ${player2.user.username} (rarity: ${rarity})`
        );
      }
    } else if (data.type === "selection") {
      const cardName = data.cardName;
      if (!cardName) return;

      ws.selection = cardName;

      // Send the selection to the opponent with sender username and role
      const opponentSocket = findOpponentSocket(ws);
      if (opponentSocket) {
        opponentSocket.send(
          JSON.stringify({
            type: "opponentSelection",
            username: ws.user.username,
            cardName: cardName,
          })
        );
      }
    } else {
      console.log(`📨 ${user.username}:`, message);
      ws.send(`You said: ${message}`);
    }
  });

  ws.on("close", () => {
    console.log(`🔌 Disconnected: ${user.username}`);

    if (ws.rarity && matchmakingQueues.has(ws.rarity)) {
      const queue = matchmakingQueues.get(ws.rarity);
      const index = queue.indexOf(ws);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }

    if (ws.opponent) {
      const opponentSocket = findOpponentSocket(ws);
      if (opponentSocket) {
        opponentSocket.send(
          JSON.stringify({
            type: "status",
            message: "Your opponent disconnected.",
          })
        );
        opponentSocket.opponent = null;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});
