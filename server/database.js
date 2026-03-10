/**
 * database.js — SQLite persistence layer
 * Replaces the in-memory db object.
 * File: server/billing.db (auto-created)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'billing.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_FILE);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    approved   INTEGER NOT NULL DEFAULT 0,
    role       TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    email      TEXT NOT NULL,
    name       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    key_value  TEXT NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    requests   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    date       TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    api_key_id   TEXT,
    model        TEXT,
    codename     TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    messages     TEXT,
    response     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    reason     TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    user_id    TEXT NOT NULL,
    window     TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    reset_at   INTEGER NOT NULL,
    PRIMARY KEY(user_id, window)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_apikeys_user    ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_prompts_user    ON prompts(user_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_date    ON prompts(created_at);
`);

// ── User helpers ──────────────────────────────────────────────────────
const Users = {
  create(id, name, email, password, approved = 0) {
    return db.prepare(`INSERT INTO users (id,name,email,password,approved) VALUES (?,?,?,?,?)`)
             .run(id, name, email, password, approved ? 1 : 0);
  },
  getByEmail(email) {
    return db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
  },
  getById(id) {
    return db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
  },
  updateName(id, name) {
    return db.prepare(`UPDATE users SET name=? WHERE id=?`).run(name, id);
  },
  approve(id) {
    return db.prepare(`UPDATE users SET approved=1 WHERE id=?`).run(id);
  },
  list() {
    return db.prepare(`SELECT id,name,email,approved,role,created_at FROM users ORDER BY created_at DESC`).all();
  },
  count() {
    return db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  }
};

// ── Session helpers ───────────────────────────────────────────────────
const Sessions = {
  create(token, userId, email, name, expiresAt) {
    return db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?)`)
             .run(token, userId, email, name, expiresAt);
  },
  get(token) {
    return db.prepare(`SELECT * FROM sessions WHERE token=?`).get(token);
  },
  delete(token) {
    return db.prepare(`DELETE FROM sessions WHERE token=?`).run(token);
  },
  cleanup() {
    return db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  }
};

// ── API Key helpers ───────────────────────────────────────────────────
const ApiKeys = {
  create(id, userId, name, keyValue) {
    return db.prepare(`INSERT INTO api_keys (id,user_id,name,key_value) VALUES (?,?,?,?)`)
             .run(id, userId, name, keyValue);
  },
  getByValue(keyValue) {
    return db.prepare(`SELECT * FROM api_keys WHERE key_value=?`).get(keyValue);
  },
  getById(id) {
    return db.prepare(`SELECT * FROM api_keys WHERE id=?`).get(id);
  },
  listByUser(userId) {
    return db.prepare(`SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC`).all(userId);
  },
  revoke(id, userId) {
    return db.prepare(`UPDATE api_keys SET active=0 WHERE id=? AND user_id=?`).run(id, userId);
  },
  delete(id, userId) {
    return db.prepare(`DELETE FROM api_keys WHERE id=? AND user_id=?`).run(id, userId);
  },
  incrementRequests(id) {
    return db.prepare(`UPDATE api_keys SET requests=requests+1 WHERE id=?`).run(id);
  }
};

// ── Usage helpers ─────────────────────────────────────────────────────
const Usage = {
  track(userId) {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO usage (user_id,date,count) VALUES (?,?,1)
      ON CONFLICT(user_id,date) DO UPDATE SET count=count+1
    `).run(userId, today);
  },
  getStats(userId) {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo  = new Date(Date.now() - 7  * 86400000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const total = db.prepare(`SELECT COALESCE(SUM(count),0) as n FROM usage WHERE user_id=?`).get(userId).n;
    const todayN = db.prepare(`SELECT COALESCE(SUM(count),0) as n FROM usage WHERE user_id=? AND date=?`).get(userId, today).n;
    const week  = db.prepare(`SELECT COALESCE(SUM(count),0) as n FROM usage WHERE user_id=? AND date>=?`).get(userId, weekAgo).n;
    const month = db.prepare(`SELECT COALESCE(SUM(count),0) as n FROM usage WHERE user_id=? AND date>=?`).get(userId, monthAgo).n;

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      const row = db.prepare(`SELECT COALESCE(count,0) as n FROM usage WHERE user_id=? AND date=?`).get(userId, d);
      days.push({ date: d, count: row ? row.n : 0 });
    }
    return { total, today: todayN, week, month, days };
  }
};

// ── Prompt collection ─────────────────────────────────────────────────
const Prompts = {
  save(userId, apiKeyId, model, codename, messages, response, inputTokens, outputTokens) {
    return db.prepare(`
      INSERT INTO prompts (user_id,api_key_id,model,codename,messages,response,input_tokens,output_tokens)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(userId, apiKeyId || null, model, codename, JSON.stringify(messages), response, inputTokens || 0, outputTokens || 0);
  },
  list(limit = 100) {
    return db.prepare(`SELECT * FROM prompts ORDER BY created_at DESC LIMIT ?`).all(limit);
  },
  count() {
    return db.prepare(`SELECT COUNT(*) as n FROM prompts`).get().n;
  },
  stats() {
    return db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as count,
             SUM(input_tokens+output_tokens) as tokens
      FROM prompts
      GROUP BY date(created_at)
      ORDER BY date DESC
      LIMIT 30
    `).all();
  }
};

// ── Waitlist ──────────────────────────────────────────────────────────
const Waitlist = {
  add(name, email, reason) {
    try {
      return db.prepare(`INSERT INTO waitlist (name,email,reason) VALUES (?,?,?)`).run(name, email, reason);
    } catch(e) {
      if (e.message.includes('UNIQUE')) return null; // Already on waitlist
      throw e;
    }
  },
  get(email) {
    return db.prepare(`SELECT * FROM waitlist WHERE email=?`).get(email);
  },
  approve(id) {
    return db.prepare(`UPDATE waitlist SET status='approved' WHERE id=?`).run(id);
  },
  list() {
    return db.prepare(`SELECT * FROM waitlist ORDER BY created_at DESC`).all();
  },
  count() {
    return db.prepare(`SELECT COUNT(*) as n FROM waitlist WHERE status='pending'`).get().n;
  }
};

// ── Rate limiting ─────────────────────────────────────────────────────
const RateLimit = {
  // Returns { allowed: bool, remaining: int, resetAt: timestamp }
  check(userId, windowMs = 3600000, maxRequests = 100) {
    const now = Date.now();
    const window = `${windowMs}`;
    const row = db.prepare(`SELECT * FROM rate_limits WHERE user_id=? AND window=?`).get(userId, window);

    if (!row || row.reset_at < now) {
      // New window
      db.prepare(`
        INSERT INTO rate_limits (user_id,window,count,reset_at) VALUES (?,?,1,?)
        ON CONFLICT(user_id,window) DO UPDATE SET count=1, reset_at=?
      `).run(userId, window, now + windowMs, now + windowMs);
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
    }

    if (row.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: row.reset_at };
    }

    db.prepare(`UPDATE rate_limits SET count=count+1 WHERE user_id=? AND window=?`).run(userId, window);
    return { allowed: true, remaining: maxRequests - row.count - 1, resetAt: row.reset_at };
  }
};

// ── Admin stats ───────────────────────────────────────────────────────
const Admin = {
  stats() {
    return {
      users:    db.prepare(`SELECT COUNT(*) as n FROM users`).get().n,
      approved: db.prepare(`SELECT COUNT(*) as n FROM users WHERE approved=1`).get().n,
      keys:     db.prepare(`SELECT COUNT(*) as n FROM api_keys WHERE active=1`).get().n,
      prompts:  db.prepare(`SELECT COUNT(*) as n FROM prompts`).get().n,
      tokens:   db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) as n FROM prompts`).get().n,
      waitlist: db.prepare(`SELECT COUNT(*) as n FROM waitlist WHERE status='pending'`).get().n,
    };
  }
};

// Cleanup expired sessions every 10 minutes
setInterval(() => Sessions.cleanup(), 10 * 60 * 1000);

module.exports = { db, Users, Sessions, ApiKeys, Usage, Prompts, Waitlist, RateLimit, Admin };
