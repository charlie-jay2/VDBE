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

// Verify JWT token and return payload or null on failure
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return null;
  }
}

// Send JSON message to a client
function send(ws, type, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON received:", e.message);
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
        username: `${payload.username}#${payload.discriminator || "0000"}`,
        id: payload.id,
        avatar: payload.avatar,
      };

      send(ws, "status", { message: "Finding match..." });

      // Remove disconnected users
      waitingUsers = waitingUsers.filter(
        (user) => user.readyState === WebSocket.OPEN
      );

      // Look for an opponent with the same rarity, but not self
      const opponent = waitingUsers.find(
        (user) => user !== ws && user.userData.rarity === ws.userData.rarity
      );

      if (opponent) {
        // Notify both clients about the match
        send(ws, "matched", { opponent: opponent.userData.username });
        send(opponent, "matched", { opponent: ws.userData.username });

        // Remove opponent from waiting list (both now matched)
        waitingUsers = waitingUsers.filter((u) => u !== opponent);
      } else {
        // No opponent found, add self to waiting list
        waitingUsers.push(ws);
        send(ws, "status", { message: "Waiting for opponent..." });
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    // Remove user from waiting list if they were waiting
    waitingUsers = waitingUsers.filter((u) => u !== ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
