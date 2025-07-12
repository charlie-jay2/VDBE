import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Use the same secret your server uses to sign JWTs
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_here";

let waitingUsers = [];

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error("JWT verification failed:", err);
    return null;
  }
}

function send(ws, type, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON:", e);
      return;
    }

    if (msg.type === "join") {
      const payload = verifyToken(msg.token);
      if (!payload) {
        send(ws, "status", { message: "Authentication failed." });
        ws.close();
        return;
      }

      ws.userData = {
        rarity: msg.rarity,
        username: payload.username + "#" + (payload.discriminator || "0000"),
        id: payload.id,
        avatar: payload.avatar,
      };

      send(ws, "status", { message: "Finding match..." });

      waitingUsers = waitingUsers.filter(
        (user) => user.readyState === WebSocket.OPEN
      );

      const opponent = waitingUsers.find(
        (user) => user !== ws && user.userData.rarity === ws.userData.rarity
      );

      if (opponent) {
        send(ws, "matched", { opponent: opponent.userData.username });
        send(opponent, "matched", { opponent: ws.userData.username });

        waitingUsers = waitingUsers.filter((u) => u !== opponent);
      } else {
        waitingUsers.push(ws);
        send(ws, "status", { message: "Waiting for opponent..." });
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    waitingUsers = waitingUsers.filter((u) => u !== ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
