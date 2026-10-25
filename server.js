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
        iterations INTEGER NOT NULL DEFAULT 120000,
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
  const identifier = email;
  try {
    if (!await emailDomainAcceptsMail(email)) return bad("Il dominio email non risulta configurato per ricevere posta.");
  } catch {
    return Response.json({ error: "Verifica temporaneamente non disponibile. Riprova tra poco." }, { status: 503 });
  }
  if (password.length < 6) return Response.json({ error: "Password di almeno 6 caratteri." }, { status: 400 });
  const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(identifier) = lower(?) OR lower(username) = lower(?)").bind(identifier, username).first();
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
    .bind(id, username, identifier, ph, s, inviteCode, referredBy, Date.now()).run();
  return Response.json({ ok: true, email, username });
}

async function requestEmailVerification(request, env) {
  const body = await request.json();
  const rawAccount = typeof body.account === "string" ? body.account.trim() : "";
  const emailInput = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const emailAccount = normalizeEmail(rawAccount);
  const account = (emailAccount || normalizePhone(rawAccount) || rawAccount).toLowerCase();
  if (!account || !password) return bad("Inserisci account e password per richiedere la verifica.");
  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(identifier) = ? OR lower(username) = ?").bind(account, account).first();
  if (!user || (await hash(password, user.salt)) !== user.password_hash) return bad("Account o password non corretti.");
  if (user.email_verified) return bad("Questo indirizzo email è già verificato.");
  const email = normalizeEmail(emailInput || user.identifier);
  if (!email) return bad("Inserisci l’indirizzo email da verificare.");
  if (email !== user.identifier) {
    const duplicate = await env.DB.prepare("SELECT id FROM users WHERE (lower(identifier) = ? OR lower(username) = ?) AND id <> ?").bind(email, email, user.id).first();
    if (duplicate) return bad("Email già associata a un altro account.");
    try {
      if (!await emailDomainAcceptsMail(email)) return bad("Il dominio email non risulta configurato per ricevere posta.");
    } catch {
      return Response.json({ error: "Verifica temporaneamente non disponibile. Riprova tra poco." }, { status: 503 });
    }
    await env.DB.prepare("UPDATE users SET identifier = ? WHERE id = ?").bind(email, user.id).run();
  }
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT requested_at, otp_expires_at, otp_attempts, verified_at FROM email_verification_requests WHERE user_id = ?").bind(user.id).first();
  if (existing?.verified_at) return bad("Questo indirizzo email è già verificato.");
  if (existing && now - existing.requested_at < 60000 && existing.otp_attempts < 5) {
    return Response.json({ ok: true, alreadyRequested: true, email, username: user.username, userId: user.id, requestedAt: existing.requested_at });
  }
  if (existing?.otp_expires_at > now && existing.otp_attempts < 5) {
    return Response.json({ ok: true, alreadyRequested: true, email, username: user.username, userId: user.id, requestedAt: existing.requested_at });
  }
  await env.DB.prepare("INSERT INTO email_verification_requests (user_id, requested_at, otp_hash, otp_salt, otp_expires_at, otp_attempts, issued_at, issued_by, verified_at) VALUES (?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL) ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL, otp_attempts = 0, issued_at = NULL, issued_by = NULL, verified_at = NULL").bind(user.id, now).run();
  return Response.json({ ok: true, email, username: user.username, userId: user.id, requestedAt: now });
}

async function confirmEmailVerification(request, env) {
  const body = await request.json();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const otp = typeof body.otp === "string" ? body.otp.trim() : "";
  if (!email || !password || !/^\d{6}$/.test(otp)) return bad("Inserisci email, password e OTP di 6 cifre.");
  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(identifier) = ?").bind(email).first();
  if (!user || (await hash(password, user.salt)) !== user.password_hash) return bad("Email o password non corrette.");
  if (user.email_verified) return bad("Questo indirizzo email è già verificato. Accedi.");
  const requestRow = await env.DB.prepare("SELECT * FROM email_verification_requests WHERE user_id = ?").bind(user.id).first();
  if (!requestRow?.otp_hash || !requestRow.otp_salt || !requestRow.otp_expires_at || requestRow.otp_expires_at < Date.now()) return bad("OTP assente o scaduto. Richiedi un nuovo codice.");
  if (requestRow.otp_attempts >= 5) return bad("Troppi tentativi. Richiedi un nuovo codice.");
  const valid = await hash(otp, requestRow.otp_salt) === requestRow.otp_hash;
  if (!valid) {
    await env.DB.prepare("UPDATE email_verification_requests SET otp_attempts = otp_attempts + 1 WHERE user_id = ?").bind(user.id).run();
    return bad("OTP non corretto.");
  }
  const now = Date.now();
  const token = makeToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(user.id),
    env.DB.prepare("UPDATE email_verification_requests SET verified_at = ?, otp_hash = NULL, otp_salt = NULL WHERE user_id = ?").bind(now, user.id),
    env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").bind(token, user.id, now),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'account', ?, ?, ?)").bind(user.id, "Email verificata", "La verifica del tuo account è stata completata con successo.", now),
  ]);
  return Response.json({ ok: true, mode: "user", token });
}

async function setUserVerificationOtp(request, env, userId) {
  const actor = await adminActor(request, env);
  if (!actor) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const body = await request.json();
  const otp = typeof body.otp === "string" ? body.otp.trim() : "";
  const notify = body.notify === true;
  if (!/^\d{6}$/.test(otp)) return bad("L’OTP deve contenere esattamente 6 cifre.");
  const user = await env.DB.prepare("SELECT id, email_verified FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "Utente non trovato." }, { status: 404 });
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const salt = genSalt();
  let title = "Codice OTP verifica email";
  let context = "verificare l’indirizzo email";
  if (user.email_verified) {
    const actionRow = await env.DB.prepare("SELECT action FROM sensitive_action_verifications WHERE user_id = ? AND consumed_at IS NULL").bind(userId).first();
    if (!actionRow) return bad("Non ci sono richieste di sicurezza in attesa per questo account.");
    context = actionRow.action === "withdrawal" ? "confermare il prelievo" : "confermare la modifica wallet";
    title = actionRow.action === "withdrawal" ? "Codice OTP per prelievo" : "Codice OTP per modifica wallet";
    const result = await env.DB.prepare("UPDATE sensitive_action_verifications SET otp_hash = ?, otp_salt = ?, otp_expires_at = ?, otp_attempts = 0, issued_at = ?, issued_by = ? WHERE user_id = ? AND consumed_at IS NULL")
      .bind(await hash(otp, salt), salt, expiresAt, Date.now(), actor.id, userId).run();
    if (!result.meta.changes) return bad("La richiesta di sicurezza non è più in attesa.");
  } else {
    const row = await env.DB.prepare("SELECT user_id FROM email_verification_requests WHERE user_id = ? AND verified_at IS NULL").bind(userId).first();
    if (!row) return bad("L’utente non ha ancora richiesto la verifica email.");
    await env.DB.prepare("UPDATE email_verification_requests SET otp_hash = ?, otp_salt = ?, otp_expires_at = ?, otp_attempts = 0, issued_at = ?, issued_by = ? WHERE user_id = ?")
      .bind(await hash(otp, salt), salt, expiresAt, Date.now(), actor.id, userId).run();
  }
  await env.DB.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'otp'").bind(userId).run();
  if (notify) {
    await createNotification(env, userId, "otp", title, "Il codice OTP per " + context + " è " + otp + ". Scade alle " + new Date(expiresAt).toLocaleTimeString("it-IT") + ".", expiresAt);
  }
  return Response.json({ ok: true, expiresAt, notificationSent: notify });
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

async function createNotification(env, userId, kind, title, message, expiresAt = null) {
  await env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, kind, title, message, Date.now(), expiresAt).run();
}

async function getNotifications(request, env) {
  const user = await authed(request, env);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM notifications WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?").bind(user.id, now).run();
  const [rows, unread] = await Promise.all([
    env.DB.prepare("SELECT id, kind, title, message, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50").bind(user.id).all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(user.id).first(),
  ]);
  return Response.json({ notifications: rows.results, unread: unread.count });
}

async function markNotificationsRead(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const now = Date.now();
  if (body.all === true) {
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now, user.id).run();
  } else {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return bad("Notifica non valida.");
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").bind(now, id, user.id).run();
  }
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
  const duplicate = await env.DB.prepare("SELECT id FROM deposits WHERE net = ? AND tx_reference = ?").bind(net, txReference).first();
  if (duplicate) return bad("Questa transazione è già stata inviata per la verifica.");
  await accrue(env, user.id);
  const created = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO deposits (user_id, amount, net, date, status, tx_reference) VALUES (?,?,?,?, 'pending', ?)").bind(user.id, amount, net, created, txReference),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'transaction', ?, ?, ? WHERE changes() = 1")
      .bind(user.id, "Richiesta di deposito inviata", amount.toFixed(2) + " USDT · " + net + " · Richiesta ricevuta e in attesa di verifica. Il saldo sarà aggiornato dopo l’approvazione.", created),
  ]);
  if (!result[0]?.meta?.changes) return bad("Questa transazione è già stata inviata per la verifica.");
  return Response.json({ ok: true, status: "pending" });
}

async function invest(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const amount = parseFloat(body.amount);
  const days = parseInt(body.days, 10);
  const plan = PLANS.find(p => p.days === days);
  if (!plan) return bad("Piano non valido.");
  if (!Number.isFinite(amount) || amount < plan.min) return bad(`Importo minimo per questo piano: ${plan.min} USDT.`);
  if (plan.days === 10 && amount > 50) return bad("Per il piano da 10 giorni l’investimento massimo è di 50 USDT.");
  const wallet = await accrue(env, user.id);
  if (amount > wallet.deposit + 1e-9) return bad("Saldo deposito insufficiente.");
  const { planBonus } = await inviterStats(env, user.id);
  const eventId = makeToken();
  const created = Date.now();
  const statements = [
    env.DB.prepare("UPDATE wallets SET deposit = deposit - ? WHERE user_id = ? AND deposit + 0.000000001 >= ?").bind(amount, user.id, amount),
    env.DB.prepare("INSERT INTO investments (user_id, amount, days, rate, created, credited, active, commission_event_id) SELECT ?, ?, ?, ?, ?, 0, 1, ? WHERE changes() = 1")
      .bind(user.id, amount, plan.days, plan.rate + planBonus, created, eventId),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'transaction', ?, ?, ? WHERE changes() = 1")
      .bind(user.id, "Investimento avviato", amount.toFixed(2) + " USDT · Piano di " + plan.days + " giorni. Il saldo deposito è stato aggiornato con successo.", created),
  ];
  const result = await env.DB.batch(statements);
  if (!result[0]?.meta?.changes || !result[1]?.meta?.changes || !result[2]?.meta?.changes) return bad("Saldo deposito insufficiente.");
  wallet.deposit -= amount;
  return Response.json({ ok: true, wallet });
}

async function requestSensitiveActionOtp(env, user, action, payload) {
  const now = Date.now();
  const payloadJson = JSON.stringify(payload);
  const existing = await env.DB.prepare("SELECT * FROM sensitive_action_verifications WHERE user_id = ?").bind(user.id).first();
  if (existing && !existing.consumed_at && existing.otp_expires_at > now && existing.otp_attempts < 5) {
    if (existing.action !== action || existing.payload_json !== payloadJson) {
      return Response.json({ error: "Hai già una verifica di sicurezza in corso. Completa o attendi la scadenza." }, { status: 409 });
    }
    return Response.json({ ok: true, otpRequired: true, alreadyRequested: true, action, payload, email: user.identifier, username: user.username, userId: user.id, requestedAt: existing.requested_at, issuedAt: existing.issued_at, otpExpiresAt: existing.otp_expires_at });
  }
  if (existing && !existing.consumed_at && now - existing.requested_at < 60000 && existing.otp_attempts < 5) {
    if (existing.action !== action || existing.payload_json !== payloadJson) {
      return Response.json({ error: "Hai già una verifica di sicurezza in corso. Completa o attendi la scadenza." }, { status: 409 });
    }
    return Response.json({ ok: true, otpRequired: true, alreadyRequested: true, action, payload, email: user.identifier, username: user.username, userId: user.id, requestedAt: existing.requested_at, issuedAt: existing.issued_at, otpExpiresAt: existing.otp_expires_at });
  }
  const actionLabel = action === "withdrawal" ? "prelievo" : "modifica wallet";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sensitive_action_verifications (user_id, action, payload_json, requested_at, otp_hash, otp_salt, otp_expires_at, otp_attempts, issued_at, issued_by, consumed_at)" +
      " VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL)" +
      " ON CONFLICT(user_id) DO UPDATE SET action = excluded.action, payload_json = excluded.payload_json, requested_at = excluded.requested_at," +
      " otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL, otp_attempts = 0, issued_at = NULL, issued_by = NULL, consumed_at = NULL"
    ).bind(user.id, action, payloadJson, now),
    env.DB.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'otp'").bind(user.id),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'otp', ?, ?, ?)")
      .bind(user.id, "Richiesta OTP in attesa", "Richiesta di " + actionLabel + " registrata. Invia l’email e attendi il codice OTP nell’app o via email.", now),
  ]);
  return Response.json({ ok: true, otpRequired: true, action, payload, email: user.identifier, username: user.username, userId: user.id, requestedAt: now });
}

async function validateWithdrawal(env, user, body, expectedAddress = "") {
  const amount = Number(body.amount);
  const net = String(body.net || "").trim();
  if (!Number.isFinite(amount) || amount < 50) return bad("Il prelievo minimo è di 50 USDT.");
  if (!["BNB", "TRC20", "BTC", "USDC"].includes(net)) return bad("Rete non valida.");
  const settings = await env.DB.prepare("SELECT withdraw_wallets FROM settings WHERE user_id = ?").bind(user.id).first();
  let wallets = {};
  try { wallets = JSON.parse(settings?.withdraw_wallets || "{}"); } catch {}
  const address = String(wallets[net] || "").trim();
  if (!address) return bad("Salva prima un indirizzo di prelievo per questa rete nel profilo.");
  if (expectedAddress && address !== expectedAddress) return bad("Il wallet di prelievo è cambiato. Invia una nuova richiesta.");
  const wallet = await accrue(env, user.id);
  if (amount > wallet.earnings + 1e-9) return bad("Saldo guadagni non sufficiente.");
  return { amount, net, address };
}

async function createWithdrawalRequest(env, user, payload) {
  const requestData = await validateWithdrawal(env, user, payload, payload.address);
  if (requestData instanceof Response) return requestData;
  const { amount, net, address } = requestData;
  const created = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET earnings = earnings - ? WHERE user_id = ? AND earnings + 0.000000001 >= ?").bind(amount, user.id, amount),
    env.DB.prepare("INSERT INTO withdrawals (user_id, amount, net, date, status, wallet_address) SELECT ?, ?, ?, ?, 'pending', ? WHERE changes() = 1").bind(user.id, amount, net, created, address),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'transaction', ?, ?, ? WHERE changes() = 1")
      .bind(user.id, "Richiesta di prelievo inviata", amount.toFixed(2) + " USDT · " + net + " · Richiesta ricevuta e in attesa di verifica. L’importo è prenotato e sarà riaccreditato se rifiutata.", created),
  ]);
  if (!result[0]?.meta?.changes || !result[1]?.meta?.changes) return bad("Saldo guadagni non sufficiente.");
  return Response.json({ ok: true, status: "pending", action: "withdrawal" });
}

async function withdraw(request, env) {
  const user = await authed(request, env);
  if (!user.email_verified) return Response.json({ error: "Verifica l’email prima di richiedere un prelievo.", verificationRequired: true, email: normalizeEmail(user.identifier) || "", account: user.identifier }, { status: 403 });
  const body = await request.json();
  const prepared = await validateWithdrawal(env, user, body);
  if (prepared instanceof Response) return prepared;
  return await requestSensitiveActionOtp(env, user, "withdrawal", prepared);
}

async function confirmSensitiveActionOtp(request, env) {
  const user = await authed(request, env);
  const otp = String((await request.json()).otp || "").trim();
  if (!/^\d{6}$/.test(otp)) return bad("Inserisci un OTP di 6 cifre.");
  const challenge = await env.DB.prepare("SELECT * FROM sensitive_action_verifications WHERE user_id = ? AND consumed_at IS NULL").bind(user.id).first();
  if (!challenge?.otp_hash || !challenge.otp_salt || !challenge.otp_expires_at || challenge.otp_expires_at < Date.now()) return bad("OTP assente o scaduto. Richiedi un nuovo codice.");
  if (challenge.otp_attempts >= 5) return bad("Troppi tentativi. Richiedi un nuovo codice.");
  if (await hash(otp, challenge.otp_salt) !== challenge.otp_hash) {
    await env.DB.prepare("UPDATE sensitive_action_verifications SET otp_attempts = otp_attempts + 1 WHERE user_id = ? AND consumed_at IS NULL").bind(user.id).run();
    return bad("OTP non corretto.");
  }
  let payload;
  try { payload = JSON.parse(challenge.payload_json); } catch { return bad("La richiesta da verificare non è valida."); }
  const consumed = await env.DB.prepare("UPDATE sensitive_action_verifications SET consumed_at = ?, otp_hash = NULL, otp_salt = NULL WHERE user_id = ? AND consumed_at IS NULL AND otp_expires_at >= ? AND otp_attempts < 5")
    .bind(Date.now(), user.id, Date.now()).run();
  if (!consumed.meta.changes) return bad("La verifica è già stata utilizzata o è scaduta.");
  if (challenge.action === "withdrawal") return await createWithdrawalRequest(env, user, payload);
  if (challenge.action === "wallet_change") return await createWalletChangeRequest(env, user, payload.wallets);
  return bad("Tipo di richiesta non valido.");
}

async function adminTransactions(request, env) {
  const user = await adminActor(request, env);
  if (!user) return Response.json({ error: "Credenziale operatore non valida o scaduta." }, { status: 403 });
  const deposits = (await env.DB.prepare("SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.date ASC LIMIT 100").all()).results;
  const withdrawals = (await env.DB.prepare("SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.date ASC LIMIT 100").all()).results;
  const walletChanges = (await env.DB.prepare("SELECT r.*, u.username, u.identifier FROM wallet_change_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.requested_at ASC LIMIT 100").all()).results;
  const emailVerifications = (await env.DB.prepare("SELECT r.user_id, r.requested_at, r.issued_at, r.otp_expires_at, u.username, u.identifier FROM email_verification_requests r JOIN users u ON u.id = r.user_id WHERE r.verified_at IS NULL ORDER BY r.requested_at ASC LIMIT 100").all()).results;
  const sensitiveActionVerifications = (await env.DB.prepare("SELECT r.user_id, r.action, r.payload_json, r.requested_at, r.issued_at, r.otp_expires_at, u.username, u.identifier FROM sensitive_action_verifications r JOIN users u ON u.id = r.user_id WHERE r.consumed_at IS NULL ORDER BY r.requested_at ASC LIMIT 100").all()).results;
  return Response.json({ deposits, withdrawals, walletChanges, emailVerifications, sensitiveActionVerifications, operator: user.username });
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
  if (!target) return Response.json({ error: "Utente non trovato." }, { status: 404 });
  const wallet = await accrue(env, target.id);
  const investments = (await env.DB.prepare("SELECT id, amount, days, rate, created, credited, active FROM investments WHERE user_id = ? ORDER BY created DESC").bind(target.id).all()).results;
  const verificationRequest = await env.DB.prepare("SELECT requested_at, issued_at, otp_expires_at, verified_at FROM email_verification_requests WHERE user_id = ?").bind(target.id).first();
  const actionVerification = await env.DB.prepare("SELECT action, payload_json, requested_at, issued_at, otp_expires_at FROM sensitive_action_verifications WHERE user_id = ? AND consumed_at IS NULL").bind(target.id).first();
  return Response.json({ user: target, wallet, investments, verificationRequest, actionVerification });
}

async function adminUpdateUserBalance(request, env, userId) {
  const actor = await adminActor(request, env);
  if (!actor) return Response.json({ error: "Accesso non autorizzato." }, { status: 403 });
  const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!target) return Response.json({ error: "Utente non trovato." }, { status: 404 });
  const body = await request.json();
  const deposit = Number(body.deposit);
  const earnings = Number(body.earnings);
  if (!Number.isFinite(deposit) || !Number.isFinite(earnings) || deposit < 0 || earnings < 0 || deposit > 1e12 || earnings > 1e12) {
    return bad("Inserisci saldi validi compresi tra 0 e 1.000.000.000.000.");
  }
  const current = await accrue(env, target.id);
  const changedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET deposit = ?, earnings = ? WHERE user_id = ?").bind(deposit, earnings, target.id),
    env.DB.prepare("INSERT INTO admin_balance_changes (user_id, actor_id, previous_deposit, new_deposit, previous_earnings, new_earnings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(target.id, actor.id, current.deposit, deposit, current.earnings, earnings, changedAt),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'transaction', ?, ?, ?)").bind(target.id, "Saldo wallet aggiornato", "Il tuo wallet è stato modificato con successo. Deposito: " + deposit.toFixed(2) + " USDT · Guadagni: " + earnings.toFixed(2) + " USDT.", changedAt),
  ]);
  return Response.json({ ok: true, wallet: { ...current, deposit, earnings } });
}

async function reviewWalletChange(env, actor, id, action) {
  const row = await env.DB.prepare("SELECT * FROM wallet_change_requests WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!row) return bad("Richiesta già gestita o non trovata.");
  const now = Date.now();
  if (action === "reject") {
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE wallet_change_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, actor.id, id),
      env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'account', ?, ?, ? WHERE changes() = 1")
        .bind(row.user_id, "Modifica wallet rifiutata", "La richiesta di modifica è stata rifiutata. I tuoi indirizzi wallet attuali non sono stati modificati.", now),
    ]);
    if (!result[0]?.meta?.changes) return bad("Richiesta già gestita.");
    return Response.json({ ok: true, status: "rejected" });
  }
  let wallets;
  try { wallets = JSON.parse(row.wallets_json); } catch { return bad("La richiesta wallet non è valida."); }
  const clean = cleanWalletInputs(wallets);
  if (!clean) return bad("La richiesta wallet non è valida.");
  const settings = await env.DB.prepare("SELECT withdraw_wallets FROM settings WHERE user_id = ?").bind(row.user_id).first();
  const oldWallets = (await env.DB.prepare("SELECT net, address_key FROM withdrawal_wallets WHERE user_id = ?").bind(row.user_id).all()).results;
  let merged = {};
  try { merged = JSON.parse(settings?.withdraw_wallets || "{}"); } catch {}
  const statements = [];
  const stagedClaims = new Set();
  const finalWallets = new Map(oldWallets.map(wallet => [wallet.net, wallet.address_key]));
  for (const [net, address] of Object.entries(clean)) {
    const key = walletAddressKey(net, address);
    const claim = await env.DB.prepare("SELECT user_id FROM wallet_address_claims WHERE address_key = ?").bind(key).first();
    if (claim && claim.user_id !== row.user_id) return bad("L’indirizzo è già associato a un altro account.");
    if (!claim && !stagedClaims.has(key)) {
      statements.push(env.DB.prepare("INSERT INTO wallet_address_claims (address_key, user_id) VALUES (?, ?)").bind(key, row.user_id));
      stagedClaims.add(key);
    }
    merged[net] = address;
    finalWallets.set(net, key);
    statements.push(env.DB.prepare("INSERT INTO withdrawal_wallets (user_id, net, address, address_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, net) DO UPDATE SET address = excluded.address, address_key = excluded.address_key, created_at = excluded.created_at").bind(row.user_id, net, address, key, now));
  }
  const activeKeys = new Set(finalWallets.values());
  for (const wallet of oldWallets) {
    if (!activeKeys.has(wallet.address_key)) statements.push(env.DB.prepare("DELETE FROM wallet_address_claims WHERE address_key = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM withdrawal_wallets WHERE address_key = ? AND user_id = ?)").bind(wallet.address_key, row.user_id, wallet.address_key, row.user_id));
  }
  statements.push(
    env.DB.prepare("INSERT INTO settings (user_id, withdraw_wallets, notifications) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET withdraw_wallets = excluded.withdraw_wallets").bind(row.user_id, JSON.stringify(merged)),
    env.DB.prepare("UPDATE wallet_change_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, actor.id, id),
  );
  const statusIndex = statements.length - 1;
  statements.push(env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'account', ?, ?, ? WHERE changes() = 1").bind(row.user_id, "Wallet modificato con successo", "La richiesta è stata approvata. I tuoi indirizzi wallet sono stati aggiornati con successo.", now));
  try {
    const result = await env.DB.batch(statements);
    if (!result[statusIndex]?.meta?.changes) return bad("Richiesta già gestita.");
  } catch (error) {
    if (String(error).includes("UNIQUE")) return bad("L’indirizzo è già associato a un altro account per questa rete.");
    throw error;
  }
  return Response.json({ ok: true, status: "approved" });
}

async function reviewTransaction(request, env) {
  const operator = await adminActor(request, env);
  if (!operator) return Response.json({ error: "Credenziale operatore non valida o scaduta." }, { status: 403 });
  const body = await request.json();
  const kind = body.kind;
  const id = Number(body.id);
  const action = body.action;
  if (!["deposit", "withdrawal", "wallet_change"].includes(kind) || !Number.isInteger(id) || id < 1 || !["approve", "reject"].includes(action)) return bad("Revisione non valida.");
  if (kind === "wallet_change") return await reviewWalletChange(env, operator, id, action);
  const row = kind === "deposit"
    ? await env.DB.prepare("SELECT * FROM deposits WHERE id = ? AND status = 'pending'").bind(id).first()
    : await env.DB.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!row) return bad("Richiesta già gestita o non trovata.");
  if (kind === "withdrawal" && action === "approve") {
    const user = await env.DB.prepare("SELECT email_verified FROM users WHERE id = ?").bind(row.user_id).first();
    if (!user?.email_verified) return bad("L’utente deve verificare l’email prima che il prelievo venga approvato.");
  }
  const now = Date.now();
  let statements;
  if (kind === "deposit" && action === "approve") {
    const ancestors = (await env.DB.prepare(
      "WITH RECURSIVE uplines(id, referred_by, level) AS (" +
      " SELECT id, referred_by, 0 FROM users WHERE id = ?" +
      " UNION ALL" +
      " SELECT u.id, u.referred_by, t.level + 1 FROM users u" +
      " JOIN uplines t ON u.id = t.referred_by WHERE t.level < 3" +
      ") SELECT id, level FROM uplines WHERE level BETWEEN 1 AND 3"
    ).bind(row.user_id).all()).results;
    const eventId = "deposit-" + id;
    statements = [
      env.DB.prepare("INSERT INTO wallets (user_id, deposit, earnings, total_deposited, total_earned, total_withdrawn) SELECT user_id, amount, 0, amount, 0, 0 FROM deposits WHERE id = ? AND status = 'pending' ON CONFLICT(user_id) DO UPDATE SET deposit = wallets.deposit + excluded.deposit, total_deposited = wallets.total_deposited + excluded.total_deposited").bind(id),
      env.DB.prepare("INSERT OR IGNORE INTO referral_first_deposits (source_user_id, deposit_id, created_at) SELECT d.user_id, d.id, ? FROM deposits d WHERE d.id = ? AND d.status = 'pending' AND NOT EXISTS (SELECT 1 FROM deposits prev WHERE prev.user_id = d.user_id AND prev.status = 'approved')").bind(now, id),
    ];
    for (const ancestor of ancestors) {
      const commission = Math.round(row.amount * REFERRAL_PCTS[ancestor.level - 1] * 100) / 100;
      if (commission <= 0) continue;
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO referral_commissions (user_id, source_user_id, event_id, level, amount, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM referral_first_deposits WHERE source_user_id = ? AND deposit_id = ?)")
          .bind(ancestor.id, row.user_id, eventId, ancestor.level, commission, now, row.user_id, id),
        env.DB.prepare("INSERT INTO wallets (user_id, deposit, earnings, total_deposited, total_earned, total_withdrawn) SELECT ?, 0, ?, 0, ?, 0 WHERE EXISTS (SELECT 1 FROM referral_commissions WHERE event_id = ? AND level = ? AND user_id = ?) ON CONFLICT(user_id) DO UPDATE SET earnings = wallets.earnings + excluded.earnings, total_earned = wallets.total_earned + excluded.total_earned")
          .bind(ancestor.id, commission, commission, eventId, ancestor.level, ancestor.id),
        env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'transaction', ?, ?, ? WHERE changes() = 1")
          .bind(ancestor.id, "Accredito referral", "Il tuo wallet è stato aggiornato con successo: accredito referral di " + commission.toFixed(2) + " USDT.", now),
      );
    }
    statements.push(env.DB.prepare("UPDATE deposits SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, operator.id, id));
  } else if (kind === "withdrawal" && action === "approve") {
    statements = [
      env.DB.prepare("UPDATE wallets SET total_withdrawn = total_withdrawn + ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM withdrawals WHERE id = ? AND status = 'pending')").bind(row.amount, row.user_id, id),
      env.DB.prepare("UPDATE withdrawals SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, operator.id, id),
    ];
  } else if (kind === "withdrawal") {
    statements = [
      env.DB.prepare("UPDATE wallets SET earnings = earnings + ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM withdrawals WHERE id = ? AND status = 'pending')").bind(row.amount, row.user_id, id),
      env.DB.prepare("UPDATE withdrawals SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, operator.id, id),
    ];
  } else {
    statements = [env.DB.prepare("UPDATE deposits SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(now, operator.id, id)];
  }
  const statusStatementIndex = statements.length - 1;
  const statusLabel = action === "approve" ? "accettato" : "rifiutato";
  const transactionLabel = kind === "deposit" ? "Deposito" : "Prelievo";
  const message = kind === "deposit"
    ? row.amount.toFixed(2) + " USDT · Richiesta " + statusLabel + (action === "approve" ? ". Importo accreditato nel wallet con successo." : ". L’importo non è stato accreditato.")
    : row.amount.toFixed(2) + " USDT · Richiesta " + statusLabel + (action === "reject" ? ". Importo riaccreditato nel wallet con successo." : ". Operazione completata.");
  statements.push(env.DB.prepare(
    "INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'transaction', ?, ?, ? WHERE changes() = 1"
  ).bind(row.user_id, transactionLabel + " " + statusLabel, message, now));
  const result = await env.DB.batch(statements);
  if (!result[statusStatementIndex]?.meta?.changes) return bad("Richiesta già gestita.");
  return Response.json({ ok: true, status: action === "approve" ? "approved" : "rejected" });
}

async function setAdminCredential(request, env) {
  if (!isProjectOwner(request)) return Response.json({ error: "Solo il proprietario del progetto può impostare le credenziali." }, { status: 403 });
  const owner = await sessionUser(request, env);
  if (!owner) return Response.json({ error: "Accedi con il tuo account dell'app." }, { status: 401 });
  const current = await env.DB.prepare("SELECT updated_by FROM admin_credentials WHERE id = 1").first();
  if (current?.updated_by && current.updated_by !== owner.id) return Response.json({ error: "Questa gestione è associata a un altro account dell'app." }, { status: 403 });
  const body = await request.json();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const secret = typeof body.password === "string" ? body.password : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Inserisci un indirizzo email valido.");
  if (secret.length < 12 || secret.length > 128) return bad("La password deve contenere da 12 a 128 caratteri.");
  const salt = genSalt();
  const iterations = 20000;
  const passwordHash = await hashAdminSecret(secret, salt, iterations);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO admin_credentials (id, salt, password_hash, updated_by, updated_at, iterations, email) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, password_hash = excluded.password_hash, updated_by = excluded.updated_by, updated_at = excluded.updated_at, iterations = excluded.iterations, email = excluded.email").bind(salt, passwordHash, owner.id, Date.now(), iterations, email),
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM admin_login_attempts"),
  ]);
  return Response.json({ ok: true });
}

async function tryOperatorLogin(env, email, password, recordFailure = true) {
  const credential = await env.DB.prepare("SELECT email, salt, password_hash, iterations, updated_by FROM admin_credentials WHERE id = 1").first();
  if (!credential?.email || email !== credential.email.toLowerCase()) return null;
  const attemptKey = email;
  const now = Date.now();
  const attempt = await env.DB.prepare("SELECT failures, locked_until FROM admin_login_attempts WHERE user_id = ?").bind(attemptKey).first();
  if (attempt?.locked_until > now) return { status: 429, error: "Troppi tentativi. Riprova tra 15 minuti." };
  let previousFailures = attempt?.failures || 0;
  if (attempt?.locked_until && attempt.locked_until <= now) {
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE user_id = ?").bind(attemptKey).run();
    previousFailures = 0;
  }
  const validLength = password.length >= 12 && password.length <= 128;
  const suppliedHash = await hashAdminSecret(validLength ? password : "", credential.salt, credential.iterations || 120000);
  if (!validLength || suppliedHash !== credential.password_hash) {
    if (!recordFailure) return { status: 401, error: "Email o password non corretti." };
    const failures = previousFailures + 1;
    const lockedUntil = failures >= 5 ? now + 15 * 60 * 1000 : 0;
    await env.DB.prepare("INSERT INTO admin_login_attempts (user_id, failures, locked_until) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until").bind(attemptKey, failures, lockedUntil).run();
    return { status: lockedUntil ? 429 : 401, error: lockedUntil ? "Troppi tentativi. Riprova tra 15 minuti." : "Email o password non corretti." };
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE user_id = ?").bind(attemptKey).run();
  const token = makeToken();
  const expiresAt = now + 30 * DAY;
  await env.DB.prepare("INSERT INTO admin_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, credential.updated_by, expiresAt).run();
  return { token, expiresAt };
}

async function adminLogout(request, env) {
  const token = (request.headers.get("x-admin-token") || "").trim();
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  return Response.json({ ok: true });
}

async function upsertSettings(env, userId, { wallets, notifications }) {
  const cur = await env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(userId).first();
  let ww = {}; let notif = true;
  if (cur) { try { ww = JSON.parse(cur.withdraw_wallets || "{}"); } catch { ww = {}; } notif = !!cur.notifications; }
  if (wallets) ww = wallets;
  if (typeof notifications === "boolean") notif = notifications;
  await env.DB.prepare(
    "INSERT INTO settings (user_id, withdraw_wallets, notifications) VALUES (?,?,?) " +
    "ON CONFLICT(user_id) DO UPDATE SET withdraw_wallets=excluded.withdraw_wallets, notifications=excluded.notifications"
  ).bind(userId, JSON.stringify(ww), notif ? 1 : 0).run();
  return { withdraw_wallets: ww, notifications: notif };
}

function cleanWalletInputs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const clean = {};
  for (const [net, rawAddress] of Object.entries(input)) {
    if (!WALLET_NETS.includes(net)) return null;
    if (typeof rawAddress !== "string") return null;
    const address = rawAddress.trim();
    if (!address) continue;
    if (address.length < 8 || address.length > 200 || /\s/.test(address)) return null;
    clean[net] = address;
  }
  return Object.keys(clean).length ? clean : null;
}

async function saveWallet(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const wallets = cleanWalletInputs(body.wallets);
  if (!wallets) return bad("Inserisci almeno un indirizzo wallet valido.");
  const existing = await env.DB.prepare("SELECT user_id FROM wallet_setup WHERE user_id = ?").bind(user.id).first();
  if (existing) return Response.json({ error: "I wallet già salvati non sono modificabili direttamente. Invia una richiesta di modifica." }, { status: 409 });
  const currentSettings = await env.DB.prepare("SELECT notifications FROM settings WHERE user_id = ?").bind(user.id).first();
  const notifications = currentSettings ? !!currentSettings.notifications : true;
  const now = Date.now();
  const statements = [env.DB.prepare("INSERT INTO wallet_setup (user_id, created_at) VALUES (?, ?)").bind(user.id, now)];
  const stagedClaims = new Set();
  for (const [net, address] of Object.entries(wallets)) {
    const key = walletAddressKey(net, address);
    const claim = await env.DB.prepare("SELECT user_id FROM wallet_address_claims WHERE address_key = ?").bind(key).first();
    if (claim && claim.user_id !== user.id) return bad("Questo indirizzo è già associato a un altro account.");
    if (!claim && !stagedClaims.has(key)) {
      statements.push(env.DB.prepare("INSERT INTO wallet_address_claims (address_key, user_id) VALUES (?, ?)").bind(key, user.id));
      stagedClaims.add(key);
    }
    statements.push(env.DB.prepare("INSERT INTO withdrawal_wallets (user_id, net, address, address_key, created_at) VALUES (?, ?, ?, ?, ?)").bind(user.id, net, address, key, now));
  }
  statements.push(env.DB.prepare("INSERT INTO settings (user_id, withdraw_wallets, notifications) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET withdraw_wallets = excluded.withdraw_wallets").bind(user.id, JSON.stringify(wallets), notifications ? 1 : 0));
  statements.push(env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'account', ?, ?, ?)").bind(user.id, "Wallet salvato con successo", "I tuoi indirizzi wallet sono stati salvati e sono pronti per l’uso.", now));
  let result;
  try {
    result = await env.DB.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes("wallet_setup.user_id")) return Response.json({ error: "I wallet già salvati non sono modificabili direttamente. Invia una richiesta di modifica." }, { status: 409 });
    if (message.includes("UNIQUE")) return bad("Questo indirizzo è già associato a un altro account per la stessa rete.");
    throw error;
  }
  if (result.some(item => !item.meta?.changes)) return Response.json({ error: "Un wallet è stato già salvato. Invia una richiesta di modifica." }, { status: 409 });
  return Response.json({ ok: true, acc: { withdraw_wallets: wallets, notifications } });
}

async function validateWalletChange(env, user, input) {
  const requested = cleanWalletInputs(input);
  if (!requested) return bad("Inserisci almeno un nuovo indirizzo wallet valido.");
  const saved = (await env.DB.prepare("SELECT net, address, address_key FROM withdrawal_wallets WHERE user_id = ?").bind(user.id).all()).results;
  if (!saved.length) return bad("Salva prima i tuoi indirizzi wallet.");
  const current = new Map(saved.map(row => [row.net, row]));
  const wallets = {};
  for (const [net, address] of Object.entries(requested)) {
    const key = walletAddressKey(net, address);
    if (current.get(net)?.address_key === key) continue;
    const duplicate = await env.DB.prepare("SELECT user_id FROM wallet_address_claims WHERE address_key = ? AND user_id <> ?").bind(key, user.id).first();
    if (duplicate) return bad("Questo indirizzo è già associato a un altro account.");
    wallets[net] = address;
  }
  if (!Object.keys(wallets).length) return bad("Nessun indirizzo da modificare.");
  const pending = await env.DB.prepare("SELECT id FROM wallet_change_requests WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
  if (pending) return Response.json({ error: "Hai già una richiesta wallet in attesa di revisione." }, { status: 409 });
  return wallets;
}

async function createWalletChangeRequest(env, user, input) {
  const wallets = await validateWalletChange(env, user, input);
  if (wallets instanceof Response) return wallets;
  const requestedAt = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO wallet_change_requests (user_id, wallets_json, requested_at) VALUES (?, ?, ?)").bind(user.id, JSON.stringify(wallets), requestedAt),
      env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) SELECT ?, 'account', ?, ?, ? WHERE changes() = 1")
        .bind(user.id, "Richiesta di modifica wallet inviata", "La richiesta è stata ricevuta. I wallet attuali restano attivi fino alla revisione.", requestedAt),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return Response.json({ error: "Hai già una richiesta wallet in attesa di revisione." }, { status: 409 });
    throw error;
  }
  return Response.json({ ok: true, status: "pending", action: "wallet_change" });
}

async function requestWalletChange(request, env) {
  const user = await authed(request, env);
  if (!user.email_verified) return Response.json({ error: "Verifica l’email prima di modificare i wallet.", verificationRequired: true, email: normalizeEmail(user.identifier) || "", account: user.identifier }, { status: 403 });
  const body = await request.json();
  const wallets = await validateWalletChange(env, user, body.wallets);
  if (wallets instanceof Response) return wallets;
  return await requestSensitiveActionOtp(env, user, "wallet_change", { wallets });
}

async function updateSettings(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const notif = typeof body.notifications === "boolean" ? body.notifications : null;
  const s = await upsertSettings(env, user.id, { notifications: notif === null ? undefined : notif });
  return Response.json({ ok: true, acc: s });
}

async function changePassword(request, env) {
  const user = await authed(request, env);
  const body = await request.json();
  const current = body.current || "";
  const next = body.next || "";
  if (next.length < 6) return bad("La nuova password deve avere almeno 6 caratteri.");
  const ph = await hash(current, user.salt);
  if (ph !== user.password_hash) return bad("Password attuale non corretta.");
  const s = genSalt();
  const hash2 = await hash(next, s);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").bind(hash2, s, user.id),
    env.DB.prepare("INSERT INTO notifications (user_id, kind, title, message, created_at) VALUES (?, 'account', ?, ?, ?)")
      .bind(user.id, "Password aggiornata", "La password del tuo account è stata modificata con successo.", Date.now()),
  ]);
  return Response.json({ ok: true });
}

// Inizializzazione database su Render
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

// Ponte Express <-> API Fetch
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

// Avvio del server su Render
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server Cloud-Invest avviato correttamente sulla porta ${PORT}`);
  });
});
