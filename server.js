/**
 * Bark Arena — Node.js server for Hostinger (or any Node host).
 * Serves the game at / and the API at /api/*, from the same address.
 * No npm packages needed: Node 20+ has fetch, Request and Response built in.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* Data lives OUTSIDE the app folder: Hostinger replaces the app folder on every
   deploy, so anything stored inside it would be wiped by an update. */
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), "bark-arena-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, "store.json");

let db = { players: {}, weekly: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let dirty = false;
function flush() {
  if (!dirty) return;
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
  fs.renameSync(FILE + ".tmp", FILE);              // atomic: never a half-written file
  dirty = false;
}
setInterval(flush, 2000).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { flush(); } finally { process.exit(0); } });

const STORE = {
  async ping() { return true; },
  async seen(a, t) { db.players[a] = t; dirty = true; },
  async weekly(a, wk, wins, xp, streak, t) {
    const k = wk + "|" + a, r = db.weekly[k] || { account: a, week: wk, wins: 0, xp: 0, streak: 0 };
    r.wins = Math.max(r.wins, wins); r.xp = Math.max(r.xp, xp); r.streak = Math.max(r.streak, streak); r.updated = t;
    db.weekly[k] = r; dirty = true;
  },
  async top(wk, col) {
    return Object.values(db.weekly).filter(r => r.week === wk && r[col] > 0)
      .sort((a, b) => b[col] - a[col]).slice(0, 10).map(r => ({ account: r.account, v: r[col] }));
  },
  async count(wk) { return Object.values(db.weekly).filter(r => r.week === wk).length; },
};

/* In-memory cache with expiry, standing in for Cloudflare KV. */
const kv = new Map();
const KV = {
  async get(k, type) { const e = kv.get(k); if (!e || e.exp < Date.now()) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
  async put(k, v, o) {
    kv.set(k, { v, exp: Date.now() + ((o && o.expirationTtl) || 3600) * 1000 });
    if (kv.size > 5000) kv.delete(kv.keys().next().value);
  },
};

/* The session secret is made once and kept, unless you set one yourself. */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, "session.secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  const s = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const env = {
  ISSUER: process.env.ISSUER, TAXON: process.env.TAXON || "",
  XUMM_API_KEY: process.env.XUMM_API_KEY, XUMM_API_SECRET: process.env.XUMM_API_SECRET,
  SESSION_SECRET: sessionSecret(),
  ORIGIN: process.env.ORIGIN || "", RETURN_URL: process.env.RETURN_URL || "",
  IPFS_GATEWAY: process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/", META_HOSTS: process.env.META_HOSTS || "*",
  STORE, KV,
};

const GAME = fs.readFileSync(path.join(ROOT, "public", "index.html"));

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > 64 * 1024) { req.destroy(); fail(new Error("too large")); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", fail);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://local");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const headers = {};
      for (const h of ["authorization", "content-type", "origin"]) if (req.headers[h]) headers[h] = req.headers[h];
      const body = ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : await readBody(req);
      const r = await worker.fetch(new Request("https://local" + (url.pathname.slice(4) || "/") + url.search,
        { method: req.method, headers, body }), env);
      const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(GAME);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`Bark Arena läuft auf Port ${process.env.PORT || 3000} · Daten in ${DATA_DIR}`);
  const miss = ["ISSUER", "XUMM_API_KEY", "XUMM_API_SECRET"].filter(k => !process.env[k]);
  if (miss.length) console.log("FEHLENDE Umgebungsvariablen: " + miss.join(", "));
});
