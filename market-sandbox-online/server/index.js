/**
 * ЕДИНЫЙ СЕРВИС КОМНАТ. Один процесс на Cloud Run — держит комнаты в
 * памяти, тикает их, и сам же обслуживает все запросы клиента.
 *
 * УПРОЩЕНИЕ ПРОТИВ ПЕРВОЙ ВЕРСИИ: раньше между клиентом и этим процессом
 * стояли Cloud Functions (joinRoom/submitCommand/closeSession/getRoster) —
 * они проверяли Firebase Auth и трогали Firestore, а сюда стучались по
 * внутреннему HTTP с секретным ключом. Это было ближе к "правильной"
 * enterprise-схеме, но для одного деплоя без командной строки лишний
 * сервис — это лишний экран настройки, лишняя переменная, лишняя точка
 * отказа. Firebase Admin SDK умеет проверять Auth-токены и писать в
 * Firestore ОТСЮДА точно так же, как из Cloud Function — так что вся
 * логика просто переехала в этот файл. Разворачивать теперь нужно только
 * ОДИН сервис.
 *
 * Аутентификация везде одна и та же: клиент кладёт Firebase ID-токен —
 * в заголовок `Authorization: Bearer <token>` для обычных HTTP-запросов,
 * и параметром `?token=` для WebSocket (у WS нет заголовков в браузере).
 */
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const admin = require("firebase-admin");
const { Room, CONFIG } = require("@market-sandbox/engine");

admin.initializeApp();
const db = admin.firestore();

// Держите выключенным везде, кроме отладочного стенда: включает вкладку
// «Отладка» (память ботов) для ВСЕХ участников комнаты.
const DEV_MODE = process.env.DEV_MODE === "true";
const STARTING_WALLET = 25000;

const app = express();
app.use(cors({ origin: true })); // публичная игра — открыт для любого источника
app.use(express.json());

/** roomId -> { room: Room, sockets: Map<uid, WebSocket>, lastRosterBroadcastAt, lastCheckpointAt } */
const rooms = new Map();

async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, reason: "нет токена авторизации" });
  try {
    req.decodedToken = await admin.auth().verifyIdToken(token);
    req.uid = req.decodedToken.uid;
    next();
  } catch (err) {
    res.status(401).json({ ok: false, reason: "недействительный токен" });
  }
}

function getOrCreateRoom(roomId, startingCapital, seed) {
  let entry = rooms.get(roomId);
  if (entry) return entry;
  const room = new Room({ id: roomId, startingCapital, seed, devMode: DEV_MODE });
  entry = { room, sockets: new Map(), lastRosterBroadcastAt: 0, lastCheckpointAt: 0 };
  rooms.set(roomId, entry);
  startTicking(roomId, entry);
  return entry;
}

/** Простейшее размещение: одна активная комната на размер взноса, пока не
 *  заполнена. Для нескольких одновременных комнат на один размер взноса —
 *  см. README, раздел «Масштабирование». */
function findOrOpenRoom(startingCapital) {
  for (const [id, entry] of rooms) {
    if (entry.room.engine.startingCapital === startingCapital &&
        entry.room.humanCount < CONFIG.market.totalPlayers) {
      return { roomId: id, entry };
    }
  }
  const roomId = `room-${startingCapital}-${Date.now().toString(36)}`;
  const entry = getOrCreateRoom(roomId, startingCapital, Date.now() % 2147483647);
  return { roomId, entry };
}

function startTicking(roomId, entry) {
  entry.timer = setInterval(() => {
    entry.room.advance(1);
    broadcastTick(entry);

    const now = Date.now();
    if (now - entry.lastRosterBroadcastAt > 1000) {
      entry.lastRosterBroadcastAt = now;
      broadcastRoster(roomId, entry);
    }
    if (now - entry.lastCheckpointAt > 10000) {
      entry.lastCheckpointAt = now;
      checkpoint(roomId, entry).catch((e) => console.error("checkpoint failed", roomId, e));
    }
  }, CONFIG.market.tickMs);
}

function broadcastTick(entry) {
  for (const [uid, ws] of entry.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ type: "tick", snapshot: entry.room.snapshotFor(uid, { level: "tick" }) }));
  }
}

function broadcastRoster(roomId, entry) {
  for (const [uid, ws] of entry.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ type: "roster", snapshot: entry.room.snapshotFor(uid, { level: "roster" }) }));
  }
  // Публичный roster-снапшот раз в секунду — то, что видят зрители без
  // WS-подключения (ARCHITECTURE.md, rooms/{roomId}/state/current).
  const publicSnap = entry.room.snapshotFor("__public__", { level: "roster" });
  db.doc(`rooms/${roomId}/state/current`).set(publicSnap).catch((e) =>
    console.error("roster persist failed", roomId, e)
  );
}

async function checkpoint(roomId, entry) {
  const data = entry.room.serializeForCheckpoint();
  await db.doc(`rooms/${roomId}/checkpoint/latest`).set({
    ...data, savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** users/{uid} — создаётся при первом обращении, если ещё не существует. */
async function ensureProfile(uid) {
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      wallet: STARTING_WALLET,
      deposited: STARTING_WALLET,
      stats: { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return ref;
}

/* ================================== API ==================================== */

app.get("/healthz", (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post("/api/joinRoom", requireAuth, async (req, res) => {
  const uid = req.uid;
  const capital = Number(req.body?.capital);
  if (!CONFIG.market.capitalOptions.includes(capital)) {
    return res.status(400).json({ ok: false, reason: "неверный размер взноса" });
  }

  const profileRef = await ensureProfile(uid);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(profileRef);
      const wallet = snap.data()?.wallet ?? 0;
      if (wallet < capital) throw new Error("недостаточно средств на балансе");
      tx.update(profileRef, { wallet: wallet - capital });
    });
  } catch (err) {
    return res.status(409).json({ ok: false, reason: err.message });
  }

  const { roomId, entry } = findOrOpenRoom(capital);
  const slot = entry.room.join(uid, req.decodedToken.name || "Игрок");
  if (!slot) {
    await profileRef.update({ wallet: admin.firestore.FieldValue.increment(capital) });
    return res.status(409).json({ ok: false, reason: "комната заполнена, попробуйте ещё раз" });
  }

  await db.doc(`rooms/${roomId}`).set({
    status: "running", startingCapital: capital, totalPlayers: CONFIG.market.totalPlayers,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await db.doc(`rooms/${roomId}/participants/${uid}`).set({
    joinedAt: admin.firestore.FieldValue.serverTimestamp(), capital,
  });

  res.json({ ok: true, roomId, playerId: slot });
});

app.post("/api/submitCommand", requireAuth, (req, res) => {
  const { roomId, command } = req.body || {};
  const entry = rooms.get(roomId);
  if (!entry) return res.status(404).json({ ok: false, reason: "комната не найдена" });
  res.json(entry.room.send(req.uid, command));
});

app.get("/api/roster/:roomId", requireAuth, (req, res) => {
  const entry = rooms.get(req.params.roomId);
  if (!entry) return res.status(404).json({ ok: false, reason: "комната не найдена" });
  res.json(entry.room.snapshotFor(req.uid, { level: "roster" }));
});

app.post("/api/closeSession", requireAuth, async (req, res) => {
  const uid = req.uid;
  const { roomId } = req.body || {};
  const entry = rooms.get(roomId);
  if (!entry) return res.status(404).json({ ok: false, reason: "комната не найдена" });

  const participantRef = db.doc(`rooms/${roomId}/participants/${uid}`);
  const participantSnap = await participantRef.get();
  const capital = participantSnap.data()?.capital ?? entry.room.engine.startingCapital;

  const before = entry.room.snapshotFor(uid, { level: "roster" });
  if (!before.you) return res.status(404).json({ ok: false, reason: "вы не в этой комнате" });
  if (before.you.position) entry.room.send(uid, { type: "TRADE", action: "CLOSE", fraction: 1, reason: "закрытие сессии" });
  const final = entry.room.snapshotFor(uid, { level: "roster" });

  const record = {
    capital, equity: final.you.equity, pnl: final.you.equity - capital,
    rank: final.rank, trades: final.you.tradeCount, ticks: entry.room.engine.getState().tick,
    price: entry.room.engine.getState().price, roomId,
    finishedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  entry.room.leave(uid);
  const ws = entry.sockets.get(uid);
  if (ws) { ws.close(); entry.sockets.delete(uid); }

  const profileRef = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(profileRef);
    const data = snap.data() || { wallet: 0, stats: { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 } };
    const stats = data.stats || { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 };
    tx.update(profileRef, {
      wallet: (data.wallet ?? 0) + record.equity,
      stats: {
        sessions: stats.sessions + 1,
        wins: stats.wins + (record.pnl > 0 ? 1 : 0),
        totalPnL: stats.totalPnL + record.pnl,
        best: Math.max(stats.best ?? 0, record.pnl),
        worst: Math.min(stats.worst ?? 0, record.pnl),
      },
    });
    tx.set(db.collection(`users/${uid}/sessions`).doc(), record);
    tx.delete(participantRef);
  });

  res.json({ ok: true, ...record });
});

/* ----------------------------------- WS ------------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomId = url.searchParams.get("roomId");
  const idToken = url.searchParams.get("token");
  if (!roomId || !idToken) { ws.close(4000, "missing roomId or token"); return; }

  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(idToken)).uid;
  } catch (e) {
    ws.close(4001, "invalid token");
    return;
  }

  const entry = rooms.get(roomId);
  if (!entry) { ws.close(4004, "room not found"); return; }
  if (!entry.room.engine.getState().playersById[uid]) {
    // Игрок обязан войти через /api/joinRoom ДО подключения по WS —
    // сокет не создаёт участника сам, только подписывает на уже существующего.
    ws.close(4003, "not joined"); return;
  }

  entry.sockets.set(uid, ws);
  ws.send(JSON.stringify({ type: "hello", snapshot: entry.room.snapshotFor(uid, { level: "full" }) }));

  ws.on("close", () => {
    if (entry.sockets.get(uid) === ws) entry.sockets.delete(uid);
    // Место игрока НЕ освобождается на дисконнект — только явным
    // /api/closeSession. См. README, «Разрывы соединения».
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`room service listening on :${PORT}`));
