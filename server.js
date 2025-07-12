const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let waitingUsers = [];

function send(ws, type, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // ✅ Skip if socket dead
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
      ws.userData = {
        rarity: msg.rarity,
        username: msg.username || `Guest${Math.floor(Math.random() * 1000)}`,
      };

      send(ws, "status", { message: "Finding match..." });

      // Clean stale connections from waitingUsers
      waitingUsers = waitingUsers.filter(
        (user) => user.readyState === WebSocket.OPEN
      );

      // Find opponent with matching rarity
      const opponent = waitingUsers.find(
        (user) => user !== ws && user.userData.rarity === ws.userData.rarity
      );

      if (opponent) {
        // Pair them
        send(ws, "matched", { opponent: opponent.userData.username });
        send(opponent, "matched", { opponent: ws.userData.username });

        // Remove opponent from waitingUsers
        waitingUsers = waitingUsers.filter((u) => u !== opponent);
      } else {
        // No match found, add to waiting list
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
