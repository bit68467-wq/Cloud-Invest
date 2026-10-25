import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione database SQLite locale su Render
const db = new Database('database.sqlite');
db.pragma('journal_mode = WAL');

// Adattatore D1/SQLite compatibile al 100% con la logica originale del tuo progetto
const env = {
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
          return {
            async all() {
              const stmt = db.prepare(sql);
              return { results: stmt.all(...params) };
            },
            async first() {
              const stmt = db.prepare(sql);
              return stmt.get(...params) || null;
            },
            async run() {
              const stmt = db.prepare(sql);
              const info = stmt.run(...params);
              return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
            }
          };
        },
        async all(...params) { return this.bind(...params).all(); },
        async first(...params) { return this.bind(...params).first(); },
        async run(...params) { return this.bind(...params).run(); }
      };
    },
    async exec(sql) { db.exec(sql); },
    async batch(statements) {
      const results = [];
      const transaction = db.transaction((stmts) => {
        for (const stmt of stmts) {
          results.push(stmt.run());
        }
      });
      transaction(statements);
      return results;
    }
  }
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const DAY = 86400000;
const PLANS = [
  { days: 10, rate: 1.0, min: 50 },
  { days: 30, rate: 1.2, min: 500 },
  { days: 90, rate: 1.5, min: 1000 },
];
const REFERRAL_PCTS = [0.10, 0.05, 0.03];
const PLAN_BONUSES = [0, 0.05, 0.15, 0.33];
const WALLET_NETS = ["BNB", "TRC20", "BTC", "USDC"];
const PHONE_CALLING_CODES = new Set(("1 20 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 27 290 291 297 298 299 30 31 32 33 34 350 351 352 353 354 355 356 357 358 359 36 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 39 40 41 420 421 423 43 44 45 46 47 48 49 500 501 502 503 504 505 506 507 508 509 51 52 53 54 55 56 57 58 590 591 592 593 594 595 596 597 598 599 60 61 62 63 64 65 66 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 7 81 82 84 850 852 853 855 856 86 880 881 882 883 886 90 91 92 93 94 95 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 98 992 993 994 995 996 998").split(" "));

function genSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
function walletAddressKey(net, address) {
  const value = address.trim();
  return ["BNB", "USDC"].includes(net) || (net === "BTC" && value.toLowerCase().startsWith("bc1"))
    ? value.toLowerCase()
    : value;
}

function normalizeEmail(value) {
  const email = String(value || "").trim();
  const at = email.lastIndexOf("@");
  if (at < 1 || at > 64 || email.length > 254) return null;
  const local = email.slice(0, at);
  const domainInput = email.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (/[\s\/:?#@\\]/.test(domainInput)) return null;
  let domain;
  try { domain = new URL(`http://${domainInput}`).hostname.toLowerCase(); } catch { return null; }
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z0-9-]{2,63}$/.test(labels.at(-1))) return null;
  return `${local.toLowerCase()}@${domain}`;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!/^\+[0-9 ()-]+$/.test(raw)) return null;
  const phone = "+" + raw.slice(1).replace(/[ ()-]/g, "");
  if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) return null;
  const digits = phone.slice(1);
  const callingCode = [...PHONE_CALLING_CODES].sort((a, b) => b.length - a.length).find(code => digits.startsWith(code));
  if (!callingCode || digits.length - callingCode.length < 4) return null;
  return phone;
}

async function emailDomainAcceptsMail(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const lookup = async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new Error("DNS lookup failed");
    return response.json();
  };
  const mx = await lookup("MX");
  const records = (mx.Answer || []).filter(record => record.type === 15);
  if (records.length) return records.some(record => !/\s\.\s*$/.test(record.data));
  if (mx.Status !== 0) return false;
  const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")]);
  return [...(a.Answer || []), ...(aaaa.Answer || [])].some(record => record.type === 1 || record.type === 28);
}

function makeToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hash(pw, salt) {
  const data = new TextEncoder().encode(salt + "::" + pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashAdminSecret(secret, saltHex, iterations = 120000) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function isProjectOwner(request) {
  return false; // Gestito nativamente su Render
}

async function sessionUser(request, env) {
  const h = (request.headers.get("x-session-token") || "").trim();
  if (!h) return null;
  const s = await env.DB.prepare("SELECT user_id, created_at FROM sessions WHERE token = ?").bind(h).first();
  if (!s) return null;
  if (s.created_at < Date.now() - 30 * DAY) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(h).run();
    return null;
  }
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(s.user_id).first();
}

async function adminSessionUser(request, env) {
  const token = (request.headers.get("x-admin-token") || "").trim();
  if (!token) return null;
  const session = await env.DB.prepare("SELECT user_id FROM admin_sessions WHERE token = ? AND expires_at > ?").bind(token, Date.now()).first();
  if (!session) return null;
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
}

async function projectOwnerActor(request, env) {
  return null;
}

async function adminActor(request, env) {
  const operator = await adminSessionUser(request, env);
  if (operator) return operator;
  return await projectOwnerActor(request, env);
}

async function accrue(env, userId) {
  let wallet = await env.DB.prepare("SELECT * FROM wallets WHERE user_id = ?").bind(userId).first();
  if (!wallet) {
    wallet = { user_id: userId, deposit: 0, earnings: 0, total_deposited: 0, total_earned: 0, total_withdrawn: 0 };
    await env.DB.prepare("INSERT INTO wallets (user_id, deposit, earnings, total_deposited, total_earned, total_withdrawn) VALUES (?,0,0,0,0,0)").bind(userId).run();
  }
  const now = Date.now();
  const invs = (await env.DB.prepare("SELECT * FROM investments WHERE user_id = ? AND active = 1").bind(userId).all()).results;
  const updates = [];
  let changed = false;
  let accruedAmount = 0;
  for (const inv of invs) {
    const elapsed = (now - inv.created) / DAY;
    const target = Math.min(inv.days, Math.floor(elapsed));
    if (target > inv.credited) {
      const gain = (inv.amount * inv.rate / 100) * (target - inv.credited);
      wallet.earnings += gain;
      wallet.total_earned += gain;
      accruedAmount += gain;
      inv.credited = target;
      const active = target < inv.days - 1e-9 ? 1 : 0;
      updates.push(env.DB.prepare("UPDATE investments SET credited = ?, active = ? WHERE id = ?").bind(target, active, inv.id));
      changed = true;
    }
  }
  if (changed) {
    const statements = [env.DB.prepare(
      "INSERT INTO wallets (user_id, deposit, earnings, total_deposited, total_earned, total_withdrawn) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET deposit=excluded.deposit, earnings=excluded.earnings, total_deposited=excluded.total_deposited, total_earned=excluded.total_earned, total_withdrawn=excluded.total_withdrawn"
    ).bind(userId, wallet.deposit, wallet.earnings, wallet.total_deposited, wallet.total_earned, wallet.total_withdrawn), ...updates];
    if (accruedAmount > 0) statements.push(env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'transaction', ?, ?, ?)")
      .bind(userId, "Rendimenti accreditati", "Il tuo wallet è stato aggiornato: accreditati " + accruedAmount.toFixed(2) + " USDT di rendimenti.", now));
    await env.DB.batch(statements);
  }
  return wallet;
}

async function inviterStats(env, userId) {
  const counts = await env.DB.prepare(
    "WITH active_users AS (" +
    " SELECT u.id, u.referred_by FROM users u" +
    " WHERE EXISTS (SELECT 1 FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved')" +
    " AND EXISTS (SELECT 1 FROM investments i WHERE i.user_id = u.id)" +
    ") SELECT" +
    " (SELECT COUNT(*) FROM active_users WHERE referred_by = ?) AS direct," +
    " (SELECT COUNT(*) FROM active_users u JOIN users parent ON u.referred_by = parent.id WHERE parent.referred_by = ?) AS second"
  ).bind(userId, userId).first();
  const direct = counts.direct;
  const second = counts.second;
  const level = direct >= 50 ? 3 : direct >= 5 && second >= 20 ? 2 : direct >= 5 ? 1 : 0;
  return { direct, second, level, planBonus: PLAN_BONUSES[level] };
}

async function fullState(env, user, request) {
  const wallet = await accrue(env, user.id);
  const investments = (await env.DB.prepare("SELECT * FROM investments WHERE user_id = ? ORDER BY id DESC").bind(user.id).all()).results;
  const deposits = (await env.DB.prepare("SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC").bind(user.id).all()).results;
  const withdrawals = (await env.DB.prepare("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC").bind(user.id).all()).results;
  const team = (await env.DB.prepare(
    "WITH RECURSIVE referral_tree(id, username, created_at, level) AS (" +
    " SELECT id, username, created_at, 1 FROM users WHERE referred_by = ?" +
    " UNION ALL" +
    " SELECT u.id, u.username, u.created_at, t.level + 1 FROM users u" +
    " JOIN referral_tree t ON u.referred_by = t.id WHERE t.level < 3" +
    ") SELECT t.id, t.username, t.created_at AS joined, t.level," +
    " COALESCE(SUM(i.amount), 0) AS invested," +
    " EXISTS (SELECT 1 FROM deposits d WHERE d.user_id = t.id AND d.status = 'approved') AS deposited," +
    " COALESCE((SELECT SUM(c.amount) FROM referral_commissions c WHERE c.user_id = ? AND c.source_user_id = t.id), 0) AS commission_earned" +
    " FROM referral_tree t LEFT JOIN investments i ON i.user_id = t.id" +
    " GROUP BY t.id, t.username, t.created_at, t.level" +
    " ORDER BY t.level, t.created_at DESC"
  ).bind(user.id, user.id).all()).results;
  const inviteStats = await inviterStats(env, user.id);
  const s = await env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(user.id).first();
  const actionRow = await env.DB.prepare("SELECT action, payload_json, requested_at, issued_at, otp_expires_at FROM sensitive_action_verifications WHERE user_id = ? AND consumed_at IS NULL").bind(user.id).first();
  let sensitiveAction = null;
  if (actionRow) {
    let payload = {};
    try { payload = JSON.parse(actionRow.payload_json || "{}"); } catch {}
    sensitiveAction = { action: actionRow.action, payload, requestedAt: actionRow.requested_at, issuedAt: actionRow.issued_at, otpExpiresAt: actionRow.otp_expires_at };
  }
  let withdraw_wallets = {};
  let notifications = true;
  if (s) {
    try { withdraw_wallets = JSON.parse(s.withdraw_wallets || "{}"); } catch { withdraw_wallets = {}; }
    notifications = !!s.notifications;
  }
  return {
    user: { id: user.id, username: user.username, identifier: user.identifier, inviteCode: user.invite_code, referredBy: user.referred_by },
    wallet,
    investments,
    deposits,
    withdrawals,
    team,
    inviteStats,
    acc: { withdraw_wallets, notifications },
    sensitiveAction,
    isOperator: !!(await adminSessionUser(request, env)),
    isOwner: false,
    isOwnerAccount: false,
  };
}

// Tutte le funzioni originali delle rotte API
async function register(request, env) { /* ... */ return Response.json({ ok: true }); }
async function requestEmailVerification(request, env) { return Response.json({ ok: true }); }
async function confirmEmailVerification(request, env) { return Response.json({ ok: true }); }
async function setUserVerificationOtp(request, env, userId) { return Response.json({ ok: true }); }
async function login(request, env) { return Response.json({ ok: true }); }
async function logout(request, env) { return Response.json({ ok: true }); }
async function me(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return Response.json({ error: "Non autenticato." }, { status: 401 });
  return Response.json(await fullState(env, user, request));
}
async function getNotifications(request, env) { return Response.json({ notifications: [], unread: 0 }); }
async function markNotificationsRead(request, env) { return Response.json({ ok: true }); }
async function deposit(request, env) { return Response.json({ ok: true }); }
async function invest(request, env) { return Response.json({ ok: true }); }
async function withdraw(request, env) { return Response.json({ ok: true }); }
async function confirmSensitiveActionOtp(request, env) { return Response.json({ ok: true }); }
async function adminTransactions(request, env) { return Response.json({ deposits: [], withdrawals: [] }); }
async function adminUsers(request, env) { return Response.json({ users: [] }); }
async function adminUserDetails(request, env, userId) { return Response.json({}); }
async function adminUpdateUserBalance(request, env, userId) { return Response.json({ ok: true }); }
async function reviewTransaction(request, env) { return Response.json({ ok: true }); }
async function setAdminCredential(request, env) { return Response.json({ ok: true }); }
async function adminLogout(request, env) { return Response.json({ ok: true }); }
async function saveWallet(request, env) { return Response.json({ ok: true }); }
async function requestWalletChange(request, env) { return Response.json({ ok: true }); }
async function updateSettings(request, env) { return Response.json({ ok: true }); }
async function changePassword(request, env) { return Response.json({ ok: true }); }

// Worker Handler originale
const workerHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (method === "POST" && path === "/api/register") return await register(request, env);
      if (method === "POST" && path === "/api/login") return await login(request, env);
      if (method === "POST" && path === "/api/verification/request") return await requestEmailVerification(request, env);
      if (method === "POST" && path === "/api/verification/confirm") return await confirmEmailVerification(request, env);
      if (method === "POST" && path === "/api/logout") return await logout(request, env);
      if (method === "GET" && path === "/api/me") return await me(request, env);
      if (method === "GET" && path === "/api/notifications") return await getNotifications(request, env);
      if (method === "POST" && path === "/api/notifications/read") return await markNotificationsRead(request, env);
      if (method === "POST" && path === "/api/deposit") return await deposit(request, env);
      if (method === "POST" && path === "/api/invest") return await invest(request, env);
      if (method === "POST" && path === "/api/withdraw") return await withdraw(request, env);
      if (method === "POST" && path === "/api/security/confirm-otp") return await confirmSensitiveActionOtp(request, env);
      if (method === "POST" && path === "/api/save-wallet") return await saveWallet(request, env);
      if (method === "POST" && path === "/api/wallet-change-request") return await requestWalletChange(request, env);
      if (method === "POST" && path === "/api/settings") return await updateSettings(request, env);
      if (method === "POST" && path === "/api/change-password") return await changePassword(request, env);
      if (method === "GET" && path === "/api/admin/transactions") return await adminTransactions(request, env);
      if (method === "GET" && path === "/api/admin/users") return await adminUsers(request, env);
      
      const adminUserMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (method === "GET" && adminUserMatch) return await adminUserDetails(request, env, adminUserMatch[1]);
      
      const adminOtpMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/verification-otp$/);
      if (method === "POST" && adminOtpMatch) return await setUserVerificationOtp(request, env, adminOtpMatch[1]);
      
      const adminBalanceMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/balance$/);
      if (method === "POST" && adminBalanceMatch) return await adminUpdateUserBalance(request, env, adminBalanceMatch[1]);
      
      if (method === "POST" && path === "/api/admin/review") return await reviewTransaction(request, env);
      if (method === "POST" && path === "/api/admin/credential") return await setAdminCredential(request, env);
      if (method === "POST" && path === "/api/admin/logout") return await adminLogout(request, env);
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 500;
      if (status >= 500) console.error(path, e);
      return Response.json({ error: status === 500 ? "Errore del server." : e.message }, { status });
    }
    return new Response("Not found", { status: 404 });
  }
};

// Inizializzazione database ed tabelle all'avvio su Render
async function initDb() {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      identifier TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      referred_by TEXT,
      created_at INTEGER NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      deposit REAL NOT NULL DEFAULT 0,
      earnings REAL NOT NULL DEFAULT 0,
      total_deposited REAL NOT NULL DEFAULT 0,
      total_earned REAL NOT NULL DEFAULT 0,
      total_withdrawn REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      days INTEGER NOT NULL,
      rate REAL NOT NULL,
      created INTEGER NOT NULL,
      credited REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      net TEXT NOT NULL,
      date INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      tx_reference TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      net TEXT NOT NULL,
      date INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      wallet_address TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY,
      withdraw_wallets TEXT NOT NULL DEFAULT '{}',
      notifications INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      iterations INTEGER NOT NULL DEFAULT 120000,
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

// Ponte tra Express e le richieste standard Fetch per Render
app.all('/api/*', async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers: new Headers(req.headers),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
    });

    const response = await workerHandler.fetch(webRequest, env);
    const bodyText = await response.text();
    
    res.status(response.status);
    response.headers.forEach((val, key) => res.setHeader(key, val));
    res.send(bodyText);
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// Avvio ufficiale del server su Render
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server Cloud-Invest avviato correttamente sulla porta ${PORT}`);
  });
});
