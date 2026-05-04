const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "brew-panel-db.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}_${Date.now().toString(16)}`;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function defaultDb() {
  const createdAt = nowIso();
  return {
    version: 1,
    createdAt,
    users: [{
      id: uid("usr"),
      username: "admin",
      role: "admin",
      passwordHash: sha256Hex("admin123"),
      createdAt,
      updatedAt: createdAt
    }],
    tasks: [],
    inventory: [],
    tanks: [],
    products: [],
    reservations: [],
    chatMessages: [],
    session: { userId: null, createdAt: null }
  };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    const db = defaultDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.users || db.users.length === 0) {
    const seed = defaultDb();
    db.users = seed.users;
  }
  if (!db.session) db.session = { userId: null, createdAt: null };
  if (!Array.isArray(db.chatMessages)) db.chatMessages = [];
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function sanitizeDb(db) {
  return {
    version: db.version,
    createdAt: db.createdAt,
    users: db.users.map(sanitizeUser),
    tasks: db.tasks || [],
    inventory: db.inventory || [],
    tanks: db.tanks || [],
    products: db.products || [],
    reservations: db.reservations || [],
    chatMessages: (db.chatMessages || []).map((item) => ({
      id: item.id,
      userId: item.userId,
      username: item.username,
      text: item.text,
      createdAt: item.createdAt
    })),
    session: { userId: null, createdAt: null }
  };
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function pdf(res, filename, contentBuffer) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "Content-Length": contentBuffer.length
  });
  res.end(contentBuffer);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = decodeURIComponent(trimmed.slice(idx + 1));
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Plik jest za duzy."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error("Niepoprawny JSON."));
      }
    });
    req.on("error", reject);
  });
}

function getCurrentUser(req, db) {
  const cookies = parseCookies(req);
  const token = cookies.brew_sid;
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  session.lastSeenAt = nowIso();
  return db.users.find((user) => user.id === session.userId) || null;
}

function listOnlineUsers(db) {
  const now = Date.now();
  const unique = new Map();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < now) {
      sessions.delete(token);
      continue;
    }
    const user = db.users.find((entry) => entry.id === session.userId);
    if (!user || unique.has(user.id)) continue;
    unique.set(user.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      lastSeenAt: session.lastSeenAt || nowIso()
    });
  }
  return Array.from(unique.values()).sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
}

function requireAuth(req, res, db) {
  const user = getCurrentUser(req, db);
  if (!user) {
    json(res, 401, { error: "Sesja wygasla. Zaloguj sie ponownie." });
    return null;
  }
  return user;
}
