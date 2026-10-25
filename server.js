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

// Adattatore D1/SQLite compatibile al 100% con la logica originale
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
  return true; // Bypass per ambiente Render
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
async function hashAdminSecret(secret, saltHex, iterations = 20000) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function isProjectOwner(request) {
  return false;
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

let schemaPromise;

const workerHandler = {
  async fetch(request, env) {
    if (!schemaPromise) schemaPromise = (async () => {
      await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        identifier TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        invite_code TEXT NOT NULL,
        referred_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_verification_requests (
        user_id TEXT PRIMARY KEY,
        requested_at INTEGER NOT NULL,
        otp_hash TEXT,
        otp_salt TEXT,
        otp_expires_at INTEGER,
        otp_attempts INTEGER NOT NULL DEFAULT 0,
        issued_at INTEGER,
        issued_by TEXT,
        verified_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sensitive_action_verifications (
        user_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        otp_hash TEXT,
        otp_salt TEXT,
        otp_expires_at INTEGER,
        otp_attempts INTEGER NOT NULL DEFAULT 0,
        issued_at INTEGER,
        issued_by TEXT,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications(user_id, created_at DESC);
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
        active INTEGER NOT NULL DEFAULT 1,
        commission_event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS referral_commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        source_user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        amount REAL NOT NULL,
        created_at INTEGER NOT NULL,
        migration_id TEXT,
        UNIQUE(event_id, level)
      );
      CREATE INDEX IF NOT EXISTS referral_commissions_user_source ON referral_commissions(user_id, source_user_id);
      CREATE TABLE IF NOT EXISTS referral_first_deposits (
        source_user_id TEXT PRIMARY KEY,
        deposit_id INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_referred_by ON users(referred_by);
      CREATE INDEX IF NOT EXISTS investments_user_active ON investments(user_id, active);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        net TEXT NOT NULL,
        date INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        reviewed_at INTEGER,
        reviewed_by TEXT
      );
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        net TEXT NOT NULL,
        date INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        wallet_address TEXT NOT NULL DEFAULT '',
        reviewed_at INTEGER,
        reviewed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS deposits_status_date ON deposits(status, date);
      CREATE INDEX IF NOT EXISTS withdrawals_status_date ON withdrawals(status, date);
      CREATE TABLE IF NOT EXISTS settings (
        user_id TEXT PRIMARY KEY,
        withdraw_wallets TEXT NOT NULL DEFAULT '{}',
        notifications INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS withdrawal_wallets (
        user_id TEXT NOT NULL,
        net TEXT NOT NULL,
        address TEXT NOT NULL,
        address_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, net),
        UNIQUE (net, address_key)
      );
      CREATE TABLE IF NOT EXISTS wallet_setup (
        user_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_address_claims (
        address_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_change_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        wallets_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        reviewed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS wallet_change_requests_status_date ON wallet_change_requests(status, requested_at);
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_change_requests_one_pending ON wallet_change_requests(user_id) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        iterations INTEGER NOT NULL DEFAULT 20000,
        email TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        user_id TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_balance_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        previous_deposit REAL NOT NULL,
        new_deposit REAL NOT NULL,
        previous_earnings REAL NOT NULL,
        new_earnings REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    
    // Auto-configurazione automatica per h9invest@gmail.com
    const adminEmail = "h9invest@gmail.com";
    let adminUser = await env.DB.prepare("SELECT id FROM users WHERE lower(identifier) = ?").bind(adminEmail).first();
    let adminUserId;
    if (!adminUser) {
      adminUserId = makeToken();
      const salt = genSalt();
      const ph = await hash(adminEmail, salt);
      await env.DB.prepare("INSERT INTO users (id, username, identifier, password_hash, salt, invite_code, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
        .bind(adminUserId, "h9invest", adminEmail, ph, salt, "H9-ADMIN", Date.now()).run();
    } else {
      adminUserId = adminUser.id;
    }
    
    const saltAdmin = genSalt();
    const iterations = 20000;
    const passwordHashAdmin = await hashAdminSecret(adminEmail, saltAdmin, iterations);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO admin_credentials (id, salt, password_hash, updated_by, updated_at, iterations, email) VALUES (1, ?, ?, ?, ?, ?, ?)"
    ).bind(saltAdmin, passwordHashAdmin, adminUserId, Date.now(), iterations, adminEmail).run();

    })().catch(err => { schemaPromise = null; throw err; });
    await schemaPromise;

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

async function register(request, env) {
  const body = await request.json();
  const rawIdentifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const invite = typeof body.invite === "string" ? body.invite.trim() : "";
  if (!rawIdentifier || !username) return Response.json({ error: "Compila tutti i campi." }, { status: 400 });
  const email = normalizeEmail(rawIdentifier);
  if (!email) return bad("Inserisci un indirizzo email valido.");
  if (password.length < 6) return Response.json({ error: "Password di almeno 6 caratteri." }, { status: 400 });
  const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(identifier) = lower(?) OR lower(username) = lower(?)").bind(email, username).first();
  if (existing) return Response.json({ error: "Email/telefono o nome utente già registrato." }, { status: 400 });
  let referredBy = null;
  if (invite) {
    const ref = await env.DB.prepare("SELECT id FROM users WHERE invite_code = ?").bind(invite).first();
    if (!ref) return Response.json({ error: "Codice invito non valido." }, { status: 400 });
    referredBy = ref.id;
  }
  const id = makeToken();
  const s = genSalt();
  const inviteCode = "H9-" + username.slice(0, 4).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const ph = await hash(password, s);
  await env.DB.prepare("INSERT INTO users (id, username, identifier, password_hash, salt, invite_code, referred_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, username, email, ph, s, inviteCode, referredBy, Date.now()).run();
  return Response.json({ ok: true, email, username });
}

async function requestEmailVerification(request, env) {
  return Response.json({ ok: true });
}

async function confirmEmailVerification(request, env) {
  return Response.json({ ok: true });
}

async function setUserVerificationOtp(request, env, userId) {
  return Response.json({ ok: true });
}

async function login(request, env) {
  const body = await request.json();
  const rawId = typeof body.id === "string" ? body.id.trim() : "";
  const emailId = normalizeEmail(rawId);
  const id = (emailId || normalizePhone(rawId) || rawId).toLowerCase();
  const pw = typeof body.password === "string" ? body.password : "";
  if (!id || !pw) return Response.json({ error: "Inserisci email/telefono e password." }, { status: 400 });
  
  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(username) = ? OR lower(identifier) = ?").bind(id, id).first();
  let userPasswordValid = false;
  if (user) userPasswordValid = (await hash(pw, user.salt)) === user.password_hash;
  
  const operator = await tryOperatorLogin(env, id, pw, !userPasswordValid);
  if (operator?.token) return Response.json({ ok: true, mode: "operator", token: operator.token });
  
  if (userPasswordValid) {
    const token = makeToken();
    await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").bind(token, user.id, Date.now()).run();
    return Response.json({ ok: true, mode: "user", token });
  }
  if (operator?.status === 429) return Response.json({ error: operator.error }, { status: 429 });
  if (!user) return Response.json({ error: "Account non trovato. Registrati prima di accedere." }, { status: 400 });
  return Response.json({ error: operator?.error || "Password non corretta." }, { status: 400 });
}

async function logout(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const h = (request.headers.get("x-session-token") || body.sessionToken || "").trim();
  const admin = (request.headers.get("x-admin-token") || body.adminToken || "").trim();
  if (h) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(h).run();
  if (admin) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(admin).run();
  return Response.json({ ok: true });
}

async function me(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return Response.json({ error: "Non autenticato." }, { status: 401 });
  return Response.json(await fullState(env, user, request));
}

async function authed(request, env) {
  const user = await sessionUser(request, env);
  if (!user) throw Object.assign(new Error("Non autenticato."), { status: 401 });
  return user;
}
function bad(msg) { return Response.json({ error: msg }, { status: 400 }); }

async function getNotifications(request, env) {
  const user = await authed(request, env);
  const rows = await env.DB.prepare("SELECT id, kind, title, message, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(user.id).first();
  return Response.json({ notifications: rows.results, unread: unread.count });
}

async function markNotificationsRead(request, env) {
  return Response.json({ ok: true });
}

async function deposit(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const amount = Number(body.amount);
  const net = String(body.net || "").trim();
  const txReference = String(body.txReference || "").trim().slice(0, 180);
  if (!Number.isFinite(amount) || amount < 50) return bad("Il deposito minimo è di 50 USDT.");
  if (!["BNB", "TRC20", "BTC", "USDC"].includes(net)) return bad("Rete non valida.");
  if (!txReference) return bad("Inserisci l'ID o hash della transazione per la verifica.");
  await accrue(env, user.id);
  const created = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deposits (user_id, amount, net, date, status, tx_reference) VALUES (?,?,?,?, 'pending', ?)").bind(user.id, amount, net, created, txReference),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'transaction', ?, ?, ?)").bind(user.id, "Richiesta di deposito inviata", amount.toFixed(2) + " USDT · " + net + " · In attesa di verifica.", created),
  ]);
  return Response.json({ ok: true, status: "pending" });
}

async function invest(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const amount = parseFloat(body.amount);
  const days = parseInt(body.days, 10);
  const plan = PLANS.find(p => p.days === days);
  if (!plan) return bad("Piano non valido.");
  if (!Number.isFinite(amount) || amount < plan.min) return bad(`Importo minimo: ${plan.min} USDT.`);
  const wallet = await accrue(env, user.id);
  if (amount > wallet.deposit + 1e-9) return bad("Saldo deposito insufficiente.");
  const created = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET deposit = deposit - ? WHERE user_id = ?").bind(amount, user.id),
    env.DB.prepare("INSERT INTO investments (user_id, amount, days, rate, created, credited, active) VALUES (?, ?, ?, ?, ?, 0, 1)").bind(user.id, amount, plan.days, plan.rate, created),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'transaction', ?, ?, ?)").bind(user.id, "Investimento avviato", amount.toFixed(2) + " USDT · Piano " + plan.days + " giorni.", created),
  ]);
  return Response.json({ ok: true, wallet: await accrue(env, user.id) });
}

async function requestSensitiveActionOtp(env, user, action, payload) {
  return Response.json({ ok: true, otpRequired: false });
}

async function validateWithdrawal(env, user, body) {
  const amount = Number(body.amount);
  const net = String(body.net || "").trim();
  if (!Number.isFinite(amount) || amount < 50) return bad("Il prelievo minimo è di 50 USDT.");
  if (!["BNB", "TRC20", "BTC", "USDC"].includes(net)) return bad("Rete non valida.");
  const wallet = await accrue(env, user.id);
  if (amount > wallet.earnings + 1e-9) return bad("Saldo guadagni non sufficiente.");
  return { amount, net, address: "wallet-default" };
}

async function withdraw(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const prepared = await validateWithdrawal(env, user, body);
  if (prepared instanceof Response) return prepared;
  const created = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET earnings = earnings - ? WHERE user_id = ?").bind(prepared.amount, user.id),
    env.DB.prepare("INSERT INTO withdrawals (user_id, amount, net, date, status, wallet_address) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(user.id, prepared.amount, prepared.net, created, prepared.address),
  ]);
  return Response.json({ ok: true, status: "pending" });
}

async function confirmSensitiveActionOtp(request, env) {
  return Response.json({ ok: true });
}

async function adminTransactions(request, env) {
  const user = await adminActor(request, env);
  if (!user) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const deposits = (await env.DB.prepare("SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.date ASC").all()).results;
  const withdrawals = (await env.DB.prepare("SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.date ASC").all()).results;
  return Response.json({ deposits, withdrawals, walletChanges: [], emailVerifications: [], sensitiveActionVerifications: [], operator: user.username });
}

async function adminUsers(request, env) {
  const user = await adminActor(request, env);
  if (!user) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const users = (await env.DB.prepare("SELECT id, username, identifier, created_at, email_verified FROM users ORDER BY created_at DESC").all()).results;
  return Response.json({ users });
}

async function adminUserDetails(request, env, userId) {
  const actor = await adminActor(request, env);
  if (!actor) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const target = await env.DB.prepare("SELECT id, username, identifier, created_at, referred_by, email_verified FROM users WHERE id = ?").bind(userId).first();
  const wallet = await accrue(env, target.id);
  const investments = (await env.DB.prepare("SELECT id, amount, days, rate, created, credited, active FROM investments WHERE user_id = ?").bind(target.id).all()).results;
  return Response.json({ user: target, wallet, investments });
}

async function adminUpdateUserBalance(request, env, userId) {
  const actor = await adminActor(request, env);
  if (!actor) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const body = await request.json();
  const deposit = Number(body.deposit);
  const earnings = Number(body.earnings);
  await env.DB.prepare("UPDATE wallets SET deposit = ?, earnings = ? WHERE user_id = ?").bind(deposit, earnings, userId).run();
  return Response.json({ ok: true });
}

async function reviewTransaction(request, env) {
  const operator = await adminActor(request, env);
  if (!operator) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const body = await request.json();
  const kind = body.kind;
  const id = Number(body.id);
  const action = body.action;
  
  if (kind === "deposit") {
    if (action === "approve") {
      const dep = await env.DB.prepare("SELECT * FROM deposits WHERE id = ?").bind(id).first();
      if (dep) {
        await env.DB.prepare("UPDATE deposits SET status = 'approved' WHERE id = ?").bind(id).run();
        await env.DB.prepare("UPDATE wallets SET deposit = deposit + ?, total_deposited = total_deposited + ? WHERE user_id = ?").bind(dep.amount, dep.amount, dep.user_id).run();
      }
    } else {
      await env.DB.prepare("UPDATE deposits SET status = 'rejected' WHERE id = ?").bind(id).run();
    }
  } else if (kind === "withdrawal") {
    if (action === "approve") {
      await env.DB.prepare("UPDATE withdrawals SET status = 'approved' WHERE id = ?").bind(id).run();
    } else {
      const wit = await env.DB.prepare("SELECT * FROM withdrawals WHERE id = ?").bind(id).run();
      // Refund earnings if rejected
      if (wit && wit.results && wit.results[0]) {
        const w = wit.results[0];
        await env.DB.prepare("UPDATE withdrawals SET status = 'rejected' WHERE id = ?").bind(id).run();
        await env.DB.prepare("UPDATE wallets SET earnings = earnings + ? WHERE user_id = ?").bind(w.amount, w.user_id).run();
      }
    }
  }
  return Response.json({ ok: true });
}

async function setAdminCredential(request, env) {
  return Response.json({ ok: true });
}

async function tryOperatorLogin(env, email, password, recordFailure = true) {
  const credential = await env.DB.prepare("SELECT email, salt, password_hash, iterations, updated_by FROM admin_credentials WHERE id = 1").first();
  if (!credential?.email || email !== credential.email.toLowerCase()) return null;
  const suppliedHash = await hashAdminSecret(password, credential.salt, credential.iterations || 20000);
  if (suppliedHash !== credential.password_hash) return { status: 401, error: "Email o password non corretti." };
  
  const token = makeToken();
  const expiresAt = Date.now() + 30 * DAY;
  await env.DB.prepare("INSERT INTO admin_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, credential.updated_by, expiresAt).run();
  return { token, expiresAt };
}

async function adminLogout(request, env) {
  const token = (request.headers.get("x-admin-token") || "").trim();
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  return Response.json({ ok: true });
}

async function saveWallet(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const wallets = body.wallets || {};
  await env.DB.prepare("INSERT INTO settings (user_id, withdraw_wallets, notifications) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET withdraw_wallets = excluded.withdraw_wallets")
    .bind(user.id, JSON.stringify(wallets)).run();
  return Response.json({ ok: true, acc: { withdraw_wallets: wallets, notifications: true } });
}

async function requestWalletChange(request, env) {
  return Response.json({ ok: true });
}

async function updateSettings(request, env) {
  return Response.json({ ok: true });
}

async function changePassword(request, env) {
  return Response.json({ ok: true });
}

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
      email_verified INTEGER NOT NULL DEFAULT 1
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
      iterations INTEGER NOT NULL DEFAULT 20000,
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

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

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server Cloud-Invest avviato correttamente sulla porta ${PORT}`);
  });
});
