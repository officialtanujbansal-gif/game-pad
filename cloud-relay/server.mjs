import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.resolve(HERE, "../phone-remote");
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.OR_DATA_DIR || path.join(HERE, "data"));
const DB_FILE = path.join(DATA_DIR, "devices.json");
const PAIR_CODE_TTL_MS = 4 * 60 * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const ALLOWED_ACTIONS = new Set([
  "up", "down", "left", "right", "select", "back", "home",
  "volume_up", "volume_down", "mute", "power_menu"
]);

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (parsed && typeof parsed.devices === "object" && parsed.devices) return parsed;
  } catch {}
  return { version: 1, devices: {} };
}
const db = loadDb();

function persistDb() {
  const temp = DB_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
  catch { return false; }
}
function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
}
function validToken(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 160;
}
function cleanName(value, fallback) {
  return typeof value === "string" ? value.trim().slice(0, 60) || fallback : fallback;
}
function getIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
}

const tvConnections = new Map();
const phoneConnections = new Map();
const pairingCodes = new Map();
const pendingPairs = new Map();
const pairAttempts = new Map();

function issuePairingCode(tvSession) {
  for (const [code, entry] of pairingCodes) {
    if (entry.tv === tvSession) pairingCodes.delete(code);
  }
  let code;
  do { code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"); }
  while (pairingCodes.has(code));
  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
  pairingCodes.set(code, { tv: tvSession, deviceId: tvSession.deviceId, expiresAt });
  send(tvSession.ws, { type: "pairing_code", code, expiresAt });
}

function rateLimitPairing(ip) {
  const now = Date.now();
  const recent = (pairAttempts.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now);
  pairAttempts.set(ip, recent);
  return recent.length <= 8;
}

function connectedPhones(deviceId) {
  return phoneConnections.get(deviceId) || new Set();
}
function notifyPhones(deviceId, payload) {
  for (const phone of connectedPhones(deviceId)) send(phone.ws, payload);
}
function removePhone(session) {
  if (!session.deviceId) return;
  const set = phoneConnections.get(session.deviceId);
  if (set) {
    set.delete(session);
    if (!set.size) phoneConnections.delete(session.deviceId);
  }
}

function handleTvHello(session, message) {
  const { deviceId, deviceToken } = message;
  if (!validId(deviceId) || !validToken(deviceToken)) {
    send(session.ws, { type: "error", code: "invalid_tv_identity", message: "TV identity is invalid." });
    session.ws.close(1008, "Invalid TV identity");
    return;
  }

  let device = db.devices[deviceId];
  if (device) {
    if (!safeEqualHex(device.deviceTokenHash, hashToken(deviceToken))) {
      send(session.ws, { type: "error", code: "tv_auth_failed", message: "TV authentication failed." });
      session.ws.close(1008, "TV authentication failed");
      return;
    }
  } else {
    device = {
      deviceTokenHash: hashToken(deviceToken),
      name: cleanName(message.deviceName, "Android TV"),
      platform: message.platform === "fire-tv" ? "fire-tv" : "android-tv",
      remotes: {},
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    db.devices[deviceId] = device;
  }

  device.name = cleanName(message.deviceName, device.name || "Android TV");
  device.platform = message.platform === "fire-tv" ? "fire-tv" : "android-tv";
  device.lastSeen = new Date().toISOString();
  persistDb();

  const old = tvConnections.get(deviceId);
  if (old && old !== session) old.ws.close(4001, "Replaced by a newer TV connection");
  session.role = "tv";
  clearTimeout(session.authTimer);
  session.platform = device.platform;
  session.deviceId = deviceId;
  tvConnections.set(deviceId, session);

  send(session.ws, {
    type: "tv_ready",
    deviceId,
    deviceName: device.name,
    pairedRemotes: Object.keys(device.remotes || {}).length
  });
  issuePairingCode(session);
  notifyPhones(deviceId, { type: "tv_status", online: true, deviceName: device.name });
}

function handlePhonePair(session, message) {
  const ip = session.ip;
  if (!rateLimitPairing(ip)) {
    send(session.ws, { type: "error", code: "pair_rate_limited", message: "Too many pairing attempts. Try again in one minute." });
    return;
  }
  const code = String(message.code || "").trim();
  const remoteId = message.remoteId;
  const remoteToken = message.remoteToken;
  if (!/^\d{6}$/.test(code) || !validId(remoteId) || !validToken(remoteToken)) {
    send(session.ws, { type: "error", code: "invalid_pair_request", message: "Enter the six-digit code shown on the TV." });
    return;
  }
  const entry = pairingCodes.get(code);
  if (!entry || entry.expiresAt < Date.now() || entry.tv.ws.readyState !== WebSocket.OPEN) {
    pairingCodes.delete(code);
    send(session.ws, { type: "error", code: "pair_code_expired", message: "That pairing code is invalid or expired. Generate a new code on the TV." });
    return;
  }

  const device = db.devices[entry.deviceId];
  const existing = device?.remotes?.[remoteId];
  if (existing && safeEqualHex(existing.tokenHash, hashToken(remoteToken))) {
    session.role = "phone";
    session.deviceId = entry.deviceId;
    session.remoteId = remoteId;
    if (!phoneConnections.has(entry.deviceId)) phoneConnections.set(entry.deviceId, new Set());
    phoneConnections.get(entry.deviceId).add(session);
    send(session.ws, { type: "paired", deviceId: entry.deviceId, deviceName: device.name, alreadyPaired: true });
    send(session.ws, { type: "tv_status", online: true, deviceName: device.name });
    return;
  }

  const requestId = randomToken(18);
  const pending = {
    requestId,
    tv: entry.tv,
    phone: session,
    deviceId: entry.deviceId,
    remoteId,
    remoteTokenHash: hashToken(remoteToken),
    remoteName: cleanName(message.remoteName, "Phone"),
    createdAt: Date.now()
  };
  pendingPairs.set(requestId, pending);
  pairingCodes.delete(code);
  send(session.ws, { type: "pair_waiting", requestId, deviceName: device.name });
  send(entry.tv.ws, {
    type: "pair_request",
    requestId,
    remoteName: pending.remoteName,
    deviceName: device.name
  });
}

function handlePairDecision(session, message) {
  const pending = pendingPairs.get(message.requestId);
  if (!pending || pending.tv !== session || session.role !== "tv") return;
  pendingPairs.delete(message.requestId);
  if (message.approved !== true) {
    send(pending.phone.ws, { type: "pair_denied", message: "Pairing was declined on the TV." });
    issuePairingCode(session);
    return;
  }

  const device = db.devices[pending.deviceId];
  if (!device) {
    send(pending.phone.ws, { type: "error", code: "device_missing", message: "TV registration was lost. Reconnect the TV app and pair again." });
    return;
  }
  device.remotes ||= {};
  device.remotes[pending.remoteId] = {
    tokenHash: pending.remoteTokenHash,
    name: pending.remoteName,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };
  persistDb();

  const phone = pending.phone;
  phone.role = "phone";
  clearTimeout(phone.authTimer);
  phone.deviceId = pending.deviceId;
  phone.remoteId = pending.remoteId;
  if (!phoneConnections.has(pending.deviceId)) phoneConnections.set(pending.deviceId, new Set());
  phoneConnections.get(pending.deviceId).add(phone);
  send(phone.ws, {
    type: "paired",
    deviceId: pending.deviceId,
    deviceName: device.name,
    platform: device.platform
  });
  send(session.ws, { type: "remote_added", remoteName: pending.remoteName });
  issuePairingCode(session);
}

function handlePhoneAuth(session, message) {
  const { deviceId, remoteId, remoteToken } = message;
  if (!validId(deviceId) || !validId(remoteId) || !validToken(remoteToken)) {
    send(session.ws, { type: "error", code: "invalid_credentials", message: "Saved pairing details are invalid." });
    return;
  }
  const device = db.devices[deviceId];
  const remote = device?.remotes?.[remoteId];
  if (!remote || !safeEqualHex(remote.tokenHash, hashToken(remoteToken))) {
    send(session.ws, { type: "error", code: "auth_failed", message: "This phone is not paired with that TV. Pair it again using the TV code." });
    return;
  }
  remote.lastSeen = new Date().toISOString();
  persistDb();
  session.role = "phone";
  clearTimeout(session.authTimer);
  session.deviceId = deviceId;
  session.remoteId = remoteId;
  if (!phoneConnections.has(deviceId)) phoneConnections.set(deviceId, new Set());
  phoneConnections.get(deviceId).add(session);
  send(session.ws, { type: "phone_ready", deviceId, deviceName: device.name, platform: device.platform });
  send(session.ws, { type: "tv_status", online: tvConnections.has(deviceId), deviceName: device.name });
}

function handleControl(session, message) {
  if (session.role !== "phone" || !session.deviceId || message.deviceId !== session.deviceId) return;
  const action = String(message.action || "");
  if (!ALLOWED_ACTIONS.has(action)) {
    send(session.ws, { type: "command_result", id: message.id || "", action, success: false, reason: "unsupported_action" });
    return;
  }
  const tv = tvConnections.get(session.deviceId);
  if (!tv || tv.ws.readyState !== WebSocket.OPEN) {
    send(session.ws, { type: "command_result", id: message.id || "", action, success: false, reason: "tv_offline" });
    return;
  }
  send(tv.ws, { type: "control", id: String(message.id || randomToken(8)), action });
}

function handleMessage(session, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { send(session.ws, { type: "error", code: "bad_json", message: "Message must be valid JSON." }); return; }
  if (!message || typeof message.type !== "string") return;

  if (session.role === null && message.type === "tv_hello") return handleTvHello(session, message);
  if (session.role === null && message.type === "phone_pair") return handlePhonePair(session, message);
  if (session.role === null && message.type === "phone_auth") return handlePhoneAuth(session, message);
  if (message.type === "pair_decision") return handlePairDecision(session, message);
  if (message.type === "control") return handleControl(session, message);
  if (message.type === "command_result" && session.role === "tv") {
    notifyPhones(session.deviceId, message);
    return;
  }
  if (message.type === "tv_capabilities" && session.role === "tv") {
    notifyPhones(session.deviceId, { type: "tv_capabilities", apiLevel: Number(message.apiLevel) || 0, androidVersion: String(message.androidVersion || ""), dpad: message.dpad === true, accessibilityEnabled: message.accessibilityEnabled === true, platform: session.platform });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "omni-remote-tv-relay", connectedTvs: tvConnections.size }));
    return;
  }
  const route = url.pathname === "/" ? "/index.html" : url.pathname;
  const allowed = new Set(["/index.html", "/app.js", "/styles.css", "/manifest.webmanifest"]);
  if (!allowed.has(route)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const file = path.join(PHONE_DIR, route.slice(1));
  fs.readFile(file, (error, buffer) => {
    if (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Phone remote assets are missing from this deployment.");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": route === "/index.html" ? "no-store" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
    res.end(buffer);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const allow = (process.env.OR_ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
      const sameOrigin = parsed.host === req.headers.host;
      if (!sameOrigin && !allow.includes(origin)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    } catch { socket.destroy(); return; }
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const session = { ws, role: null, deviceId: null, remoteId: null, ip: getIp(req) };
  session.authTimer = setTimeout(() => { if (session.role === null) ws.close(1008, "Authentication timeout"); }, 120_000);
  ws.on("message", data => handleMessage(session, data));
  ws.on("close", () => {
    clearTimeout(session.authTimer);
    if (session.role === "tv" && tvConnections.get(session.deviceId) === session) {
      tvConnections.delete(session.deviceId);
      for (const [code, entry] of pairingCodes) if (entry.tv === session) pairingCodes.delete(code);
      notifyPhones(session.deviceId, { type: "tv_status", online: false });
    }
    if (session.role === "phone") removePhone(session);
    for (const [requestId, pending] of pendingPairs) {
      if (pending.phone === session) pendingPairs.delete(requestId);
      if (pending.tv === session) {
        pendingPairs.delete(requestId);
        send(pending.phone.ws, { type: "error", code: "tv_disconnected", message: "TV disconnected during pairing." });
      }
    }
  });
  ws.on("error", () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, entry] of pairingCodes) {
    if (entry.expiresAt < now) {
      pairingCodes.delete(code);
      if (entry.tv.ws.readyState === WebSocket.OPEN) issuePairingCode(entry.tv);
    }
  }
  for (const [id, pending] of pendingPairs) {
    if (now - pending.createdAt > 90_000) {
      pendingPairs.delete(id);
      send(pending.phone.ws, { type: "error", code: "pair_timeout", message: "TV approval timed out. Try pairing again." });
    }
  }
  for (const [ip, times] of pairAttempts) {
    const recent = times.filter(t => now - t < 60_000);
    if (recent.length) pairAttempts.set(ip, recent); else pairAttempts.delete(ip);
  }
}, 30_000);
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OmniRemote TV relay listening on :${PORT}`);
});
function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, "Relay shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
