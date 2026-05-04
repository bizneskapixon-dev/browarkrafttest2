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
