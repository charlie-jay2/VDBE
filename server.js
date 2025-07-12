import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import axios from "axios";
import cors from "cors";
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

app.use(cors());
app.use(express.json());

// 🛠️ Discord OAuth callback
app.get("/auth/discord", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code provided");

  try {
    // Exchange code for access token
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

    // Fetch user info
    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userResponse.data;

    // Sign our own JWT
    const jwtPayload = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
    };

    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "7d" });

    console.log(`✅ Authenticated: ${user.username}#${user.discriminator}`);

    // Redirect to frontend with JWT
    res.redirect(`${FRONTEND_URL}?token=${token}`);
  } catch (err) {
    console.error(
      "❌ Discord OAuth failed:",
      err.response?.data || err.message
    );
    res.status(500).send("Discord authentication failed");
  }
});

// 🕵️‍♂️ WebSocket authentication function
function verifyClient(info, done) {
  const authHeader = info.req.headers["sec-websocket-protocol"];
  if (!authHeader) {
    console.warn("❌ No token provided in WebSocket protocol header");
    return done(false, 401, "Unauthorized");
  }

  const token = authHeader.split(",")[0].trim(); // client sends JWT here

  try {
    const user = jwt.verify(token, JWT_SECRET);
    info.req.user = user; // attach user info for handlers
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
    done(true);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    done(false, 401, "Invalid token");
  }
}

// 🚀 Upgrade HTTP server to handle WS connections with auth
server.on("upgrade", (req, socket, head) => {
  verifyClient({ req }, (verified, code, message) => {
    if (!verified) {
      socket.write(
        `HTTP/1.1 ${code} ${message}\r\n` + "Connection: close\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
});

// 🎯 WebSocket handlers
wss.on("connection", (ws, req) => {
  const user = req.user;
  ws.send(`👋 Welcome ${user.username}#${user.discriminator}`);

  ws.on("message", (message) => {
    console.log(`📨 ${user.username}:`, message.toString());
    ws.send(`You said: ${message}`);
  });

  ws.on("close", () => {
    console.log(`🔌 Disconnected: ${user.username}`);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});
