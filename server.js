const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const http = require("http");

const JWT_SECRET = process.env.JWT_SECRET || "your_secret_here";
const PORT = 3000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const players = new Map();
const queue = [];
const matches = new Map();
const playerStates = new Map();
const disconnectTimers = new Map();

const cardStats = {
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

function heartbeat() {
  this.isAlive = true;
}

function clearDisconnectTimer(username) {
  const timer = disconnectTimers.get(username);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(username);
  }
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

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
    ws.user = user;
    console.log(`✅ WS Authenticated: ${user.username}#${user.discriminator}`);
  } catch (err) {
    console.error("❌ WS JWT verification failed:", err.message);
    ws.close(1008, "Invalid token");
    return;
  }

  ws.rarity = null;

  const prevState = playerStates.get(user.username);
  if (prevState && !prevState.isConnected) {
    console.log(`🔄 Reconnection for ${user.username}`);
    clearDisconnectTimer(user.username);

    prevState.socket = ws;
    prevState.isConnected = true;

    const opponentSocket = matches.get(user.username);
    if (opponentSocket) {
      matches.set(user.username, opponentSocket);
      matches.set(opponentSocket.user.username, ws);
    }

    console.log(`🔄 Reconnected ${user.username}`);
  }

  playerStates.set(user.username, {
    socket: ws,
    isConnected: true,
  });

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.warn("❌ Invalid JSON from client:", err.message);
      return;
    }

    if (data.type === "join") {
      const rarity = data.rarity;
      ws.rarity = rarity;
      queue.push(ws);
      console.log(`🎲 ${user.username} joined queue with rarity ${rarity}`);

      if (queue.length >= 2) {
        const [player1, player2] = [queue.shift(), queue.shift()];
        matches.set(player1.user.username, player2);
        matches.set(player2.user.username, player1);

        [player1, player2].forEach((player, i) => {
          player.send(
            JSON.stringify({
              type: "matched",
              opponent: i === 0 ? player2.user.username : player1.user.username,
            })
          );
        });

        console.log(
          `🤝 Match created: ${player1.user.username} vs ${player2.user.username}`
        );
      }
    }

    if (data.type === "selection") {
      const opponentSocket = matches.get(user.username);
      if (opponentSocket && opponentSocket.readyState === WebSocket.OPEN) {
        opponentSocket.send(
          JSON.stringify({
            type: "opponentSelection",
            cardName: data.cardName,
          })
        );
        console.log(
          `📤 Sent opponentSelection: ${data.cardName} to ${opponentSocket.user.username}`
        );
      }
    }

    if (data.type === "getCardStats") {
      console.log(`📩 Received from ${user.username}#0:`, data);

      let foundStats = null;

      for (const tier in cardStats) {
        const tierData = cardStats[tier];
        for (const name in tierData) {
          const filename = name.replace(/\s+/g, "").toLowerCase();
          const compareName = data.cardName
            .replace(/\.(png|jpg|jpeg)/gi, "")
            .toLowerCase();
          if (compareName.includes(filename)) {
            foundStats = { ...tierData[name], cardName: data.cardName };
            break;
          }
        }
        if (foundStats) break;
      }

      if (foundStats) {
        ws.send(
          JSON.stringify({
            type: "cardStats",
            cardName: foundStats.cardName,
            SP: foundStats.SP,
            VR: foundStats.VR,
          })
        );
        console.log(
          `✅ Sent stats for ${foundStats.cardName}: SP=${foundStats.SP}, VR=${foundStats.VR}`
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Card stats not found for: ${data.cardName}`,
          })
        );
        console.warn(`❌ Card stats not found for: ${data.cardName}`);
      }
    }
  });

  ws.on("close", () => {
    console.warn(`⚠️ WS closed: ${user.username}`);
    const state = playerStates.get(user.username);
    if (state) {
      state.isConnected = false;
    }

    disconnectTimers.set(
      user.username,
      setTimeout(() => {
        console.log(`🗑️ Cleaning up ${user.username}`);
        playerStates.delete(user.username);
        matches.delete(user.username);
      }, 10000)
    ); // 10s grace period
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on ws://localhost:${PORT}`);
});
