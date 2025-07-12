const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const waitingUsers = [];

function send(ws, type, data) {
  ws.send(JSON.stringify({ type, ...data }));
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Invalid message", e);
      return;
    }

    if (msg.type === "join") {
      ws.userData = {
        rarity: msg.rarity,
        username: msg.username || "Unknown",
      };

      send(ws, "status", { message: "Finding match..." });

      let matchedIndex = waitingUsers.findIndex(
        (user) => user.ws !== ws && user.userData.rarity === ws.userData.rarity
      );

      if (matchedIndex !== -1) {
        const matchedUser = waitingUsers.splice(matchedIndex, 1)[0];
        const selfIndex = waitingUsers.findIndex((u) => u.ws === ws);
        if (selfIndex !== -1) waitingUsers.splice(selfIndex, 1);

        send(ws, "matched", { opponent: matchedUser.userData.username });
        send(matchedUser.ws, "matched", { opponent: ws.userData.username });
      } else {
        waitingUsers.push(ws);
      }
    }
  });

  ws.on("close", () => {
    const index = waitingUsers.indexOf(ws);
    if (index !== -1) {
      waitingUsers.splice(index, 1);
    }
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
