import express from "express";
import http from "http";
import WebSocket from "ws";
import fetch from "node-fetch";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let waitingUsers = [];

async function getDiscordUsername(token) {
  try {
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
    const user = await res.json();
    return `${user.username}#${user.discriminator}`;
  } catch (err) {
    console.error("Failed to get Discord username:", err);
    return null;
  }
}

function send(ws, type, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", async (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON:", e);
      return;
    }

    if (msg.type === "join") {
      const username = await getDiscordUsername(msg.token);
      if (!username) {
        send(ws, "status", { message: "Authentication failed." });
        ws.close();
        return;
      }

      ws.userData = {
        rarity: msg.rarity,
        username,
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
