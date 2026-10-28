Const TOKEN_KEY = 'h9_token';
const ADMIN_TOKEN_KEY = 'h9_admin_token';
const DAY = 86400000;

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const fmtC = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const statusLabel = status => ({ pending: 'In verifica', approved: 'Approvato', rejected: 'Rifiutato' }[status] || 'Completato');
const escapeHTML = value => String(value ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));

const PLANS = [
  { days: 10, rate: 1.0, min: 50,   note: 'Rendita rapida' },
  { days: 30, rate: 1.2, min: 500,  note: 'Bilanciato' },
  { days: 90, rate: 1.5, min: 1000, note: 'Max rendimento' },
];
const LEVELS = [{ n: 1, pct: 0.10 }, { n: 2, pct: 0.05 }, { n: 3, pct: 0.03 }];
const NETS = [
  { id: 'BNB',   name: 'BNB (BEP-20)', addr: 'bnb1k4f9qT3yH7wR2pLm8ZaS5' },
  { id: 'TRC20', name: 'TRC20',        addr: 'TN3gQv8pA2xC6kJdWr9mE1hY' },
  { id: 'BTC',   name: 'BTC',          addr: 'bc1q7xF9zW4sR2vT8nL6pG3aD' },
  { id: 'USDC',  name: 'USDC',         addr: '0xE3aC9fK2mN7qB4vD8xR5tJ1' },
];

let state = null;
let token = localStorage.getItem(TOKEN_KEY);
let adminToken = localStorage.getItem(ADMIN_TOKEN_KEY);

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['x-session-token'] = token;
  if (adminToken) headers['x-admin-token'] = adminToken;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const error = new Error((body && body.error) || 'Errore del server.');
    error.status = res.status;
    error.verificationRequired = !!body?.verificationRequired;
    error.email = body?.email || '';
    error.account = body?.account || '';
    throw error;
  }
  return body;
}
let refreshInFlight = null;
async function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = api('/api/me').then(st => {
      state = st;
      renderPendingAction();
      return st;
    }).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

let notificationRows = [];
let notificationPollTimer = null;
function renderNotifications() {
  const list = $('notificationList');
  if (!notificationRows.length) {
    list.innerHTML = '<p class="hint">Nessuna notifica.</p>';
    return;
  }
  list.innerHTML = notificationRows.map(item =>
    '<button class="notification-item ' + (item.read_at ? 'read' : 'unread') + '" type="button" data-notification-id="' + Number(item.id) + '" data-notification-kind="' + escapeHTML(item.kind) + '" aria-label="' + (item.read_at ? 'Notifica letta' : 'Segna come letta') + ': ' + escapeHTML(item.title) + '">' +
      '<b>' + escapeHTML(item.title) + '</b><time>' + new Date(item.created_at).toLocaleString('it-IT') + '</time><span>' + escapeHTML(item.message) + '</span>' +
    '</button>'
  ).join('');
}
async function loadNotifications() {
  if (!token || $('appBody').hidden) return;
  try {
    const data = await api('/api/notifications');
    const nextRows = data.notifications || [];
    if (JSON.stringify(nextRows) !== JSON.stringify(notificationRows)) {
      notificationRows = nextRows;
      renderNotifications();
    }
    const count = Number(data.unread) || 0;
    $('notificationCount').textContent = count > 99 ? '99+' : String(count);
    $('notificationCount').hidden = count === 0;
    $('notificationBell').setAttribute('aria-label', count ? 'Notifiche, ' + count + ' non lette' : 'Notifiche');
  } catch (err) {
    if (err.status === 401) stopNotificationPolling();
  }
}
function startNotificationPolling() {
  stopNotificationPolling();
  notificationRows = [];
  loadNotifications();
  notificationPollTimer = setInterval(loadNotifications, 5000);
}
function stopNotificationPolling() {
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
}
$('notificationBell').addEventListener('click', () => {
  const panel = $('notificationPanel');
  const open = panel.hidden;
  panel.hidden = !open;
  $('notificationBell').setAttribute('aria-expanded', String(open));
  if (open) loadNotifications();
});
$('notificationClear').addEventListener('click', async () => {
  try {
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) });
    await loadNotifications();
  } catch {}
});
$('notificationList').addEventListener('click', async event => {
  const item = event.target.closest('[data-notification-id]');
  if (!item || item.classList.contains('read')) return;
  try {
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ id: Number(item.dataset.notificationId) }) });
    await loadNotifications();
    if (item.dataset.notificationKind === 'otp') {
      await refresh();
      if (state?.sensitiveAction?.issuedAt && state.sensitiveAction.otpExpiresAt > Date.now()) openSensitiveActionOtp();
      else $('otpPendingCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch {}
});
document.addEventListener('click', event => {
  if (!event.target.closest('.notification-wrap')) {
    $('notificationPanel').hidden = true;
    $('notificationBell').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadNotifications();
});

function avatar(name) {
  const c = encodeURIComponent((name || 'I').trim().charAt(0).toUpperCase());
  return 'data:image/svg+xml;utf8,' + `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>
    <rect width='80' height='80' rx='40' fill='%23c6a76a'/>
    <text x='50%' y='54%' font-size='34' fill='white' font-family='sans-serif' text-anchor='middle' dominant-baseline='middle'>${c}</text></svg>`;
}

function enterApp() {
  $('authScreen').hidden = true;
  $('operatorScreen').hidden = true;
  $('appBody').hidden = false;
  renderApp();
  go('home');
  startNotificationPolling();
}
async function enterOperator(data) {
  $('authScreen').hidden = true;
  $('appBody').hidden = true;
  $('operatorScreen').hidden = false;
  await renderAdminQueue(true, data);
  await renderOperatorOverview();
}
async function logoutOperator() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  adminToken = null;
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  $('operatorScreen').hidden = true;
  if (token) {
    try {
      await refresh();
      enterApp();
      return;
    } catch {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  $('authScreen').hidden = false;
  resetAuthTabs();
}
async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  stopNotificationPolling();
  $('notificationPanel').hidden = true;
  $('notificationBell').setAttribute('aria-expanded', 'false');
  token = null;
  adminToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  state = null;
  $('authScreen').hidden = false;
  $('operatorScreen').hidden = true;
  $('appBody').hidden = true;
  $('loginForm').hidden = false;
  $('registerForm').hidden = true;
  $('loginId').value = ''; $('loginPass').value = '';
  hideAuthMsg();
  resetAuthTabs();
}

const VIEWS = ['home', 'invest', 'withdraw', 'my', 'team', 'profile'];
function go(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.goto === name));
  window.scrollTo({ top: 0 });
  if (name === 'home') renderHome();
  if (name === 'invest') { renderInvest(); recalc(); }
  if (name === 'withdraw') renderWithdraw();
  if (name === 'my') renderMy();
  if (name === 'team') renderTeam();
  if (name === 'profile') renderProfile();
}
function renderApp() { applyIdentity(); renderHome(); renderProfile(false); }
document.querySelectorAll('.nav-item, [data-goto]').forEach(el => {
  el.addEventListener('click', () => go(el.dataset.goto));
});

function applyIdentity() {
  const u = state.user;
  $('barName').textContent = u.username;
  $('barUser').textContent = u.username;
  $('helloName').textContent = u.username;
  $('profileName').textContent = u.username;
  $('profileId').textContent = u.identifier;
  $('profileTag').textContent = u.inviteCode ? `Codice invito: ${u.inviteCode}` : 'Investitore';
  [$('appbarAvatar'), $('profileAvatar')].forEach(img => img.src = avatar(u.username));
}
let depositNet = NETS[0];
function renderHomeDeposit() {
  $('netList').innerHTML = NETS.map(net =>
    '<button class="net ' + (net.id === depositNet.id ? 'active' : '') + '" data-net="' + net.id + '"><b>' + net.name + '</b><small>USDT</small></button>'
  ).join('');
  document.querySelectorAll('#netList [data-net]').forEach(button => button.onclick = () => {
    depositNet = NETS.find(net => net.id === button.dataset.net);
    renderHomeDeposit();
  });
  $('depNetName').textContent = depositNet.name;
  $('depAddr').textContent = depositNet.addr;
}
function planRate(plan) {
  return plan.rate + (state.inviteStats?.planBonus || 0);
}
function renderHome() {
  const w = state.wallet;
  $('homeDeposit').textContent = fmt(w.deposit);
  $('homeEarnings').textContent = fmt(w.earnings);
  $('homeActiveMoney').textContent = fmtC(investedActive());
  $('homeActiveCount').textContent = activeInvestments().length;
  $('homeEarned').textContent = fmtC(w.total_earned);
  $('homePlanList').innerHTML = PLANS.map((p, i) => `
    <div class="plan-chip ${i === 2 ? 'best' : ''}">
      <div class="pp">${planRate(p).toLocaleString('it-IT')}%<small>/gg</small></div>
      <div class="pd">${p.days} giorni</div>
      <div class="pmin">da ${fmtC(p.min)}${p.days === 10 ? ' · max $50' : ''}</div>
    </div>`).join('');
}

let activePlan = PLANS[0];
function renderInvest() {
  const input = $('amount');
  const max = activePlan.days === 10 ? 50 : null;
  input.min = String(activePlan.min);
  if (max) input.max = String(max);
  else input.removeAttribute('max');
  const current = Number(input.value);
  if (!Number.isFinite(current) || current < activePlan.min) input.value = String(activePlan.min);
  if (max && current > max) input.value = String(max);
  $('investAmountLabel').textContent = 'Importo da investire (USDT) · min ' + activePlan.min + (max ? ' · max 50' : '');
  $('plans').innerHTML = PLANS.map((p, i) => `
    <button class="plan ${i === PLANS.indexOf(activePlan) ? 'active' : ''}" data-plan="${i}">
      <div class="plan-title">${p.days} giorni</div>
      <div class="plan-rate">${planRate(p).toLocaleString('it-IT')}%<em>/gg</em></div>
      <div class="plan-note">min ${fmtC(p.min)}${p.days === 10 ? ' · max $50' : ''}</div>
    </button>`).join('');
  document.querySelectorAll('#plans [data-plan]').forEach(b => b.onclick = () => {
    activePlan = PLANS[+b.dataset.plan];
    renderInvest();
  });
  recalc();
}
function recalc() {
  const v = Math.max(0, parseFloat($('amount').value) || 0);
  const daily = v * planRate(activePlan) / 100;
  const tot = daily * activePlan.days;
  $('outDaily').textContent = fmt(daily);
  $('outTotal').textContent = fmt(tot);
  $('outFinal').textContent = fmt(v + tot);
}
$('amount').addEventListener('input', recalc);

$('homeDepositToggle').addEventListener('click', () => {
  const panel = $('homeDepositPanel');
  panel.hidden = !panel.hidden;
  $('homeDepositToggle').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) {
    renderHomeDeposit();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});
$('depositBtn').addEventListener('click', async () => {
  const amount = Math.max(0, parseFloat($('depAmount').value) || 0);
  const txReference = $('depTx').value.trim();
  if (amount < 50) { $('depAmount').focus(); alert('Il deposito minimo è di 50 USDT.'); return; }
  if (!txReference) { $('depTx').focus(); alert('Inserisci l’ID o hash della transazione.'); return; }
  if (!confirm('Invii la richiesta di deposito di ' + fmt(amount) + ' USDT su ' + depositNet.name + ' per verifica?')) return;
  $('depositBtn').disabled = true;
  try {
    await api('/api/deposit', { method: 'POST', body: JSON.stringify({ amount, net: depositNet.id, txReference }) });
    await refresh();
    alert('Richiesta di deposito di ' + fmt(amount) + ' USDT inviata. Il saldo verrà aggiornato dopo la verifica dell’operatore.');
    $('depAmount').value = '100';
    $('depTx').value = '';
    $('homeDepositPanel').hidden = true;
    $('homeDepositToggle').setAttribute('aria-expanded', 'false');
    renderHome();
    renderProfile();
  } catch (error) { alert(error.message); }
  $('depositBtn').disabled = false;
});

$('buyBtn').addEventListener('click', async () => {
  const v = parseFloat($('amount').value) || 0;
  if (v < activePlan.min) { alert(`Importo minimo per questo piano: ${fmtC(activePlan.min)} USDT.`); return; }
  if (activePlan.days === 10 && v > 50) { alert('Per il piano da 10 giorni l’investimento massimo è di 50 USDT.'); return; }
  const daily = v * planRate(activePlan) / 100;
  const tot = daily * activePlan.days;
  if (!confirm(`Acquisti ${activePlan.days} giorni al ${planRate(activePlan).toLocaleString('it-IT')}%/gg con ${fmt(v)}?\n\nGuadagno totale previsto: ${fmt(tot)}`)) return;
  $('buyBtn').disabled = true;
  try {
    await api('/api/invest', { method: 'POST', body: JSON.stringify({ amount: v, days: activePlan.days }) });
    await refresh();
    alert(`Investimento avviato.\nGiornaliero: ${fmt(daily)}\nTotale: ${fmt(tot)} dopo ${activePlan.days} giorni\n\nI guadagni maturano ogni giorno nel saldo guadagni.`);
    $('amount').value = String(activePlan.min);
    recalc();
    renderHome(); renderInvest();
  } catch (e) { alert(e.message); }
  $('buyBtn').disabled = false;
});

let wdNet = NETS[0];
function renderWithdraw() {
  $('wdAvailable').textContent = fmt(state.wallet.earnings);
  $('wdNetName').textContent = wdNet.name;
  $('wdAddress').textContent = (acc().withdraw_wallets || {})[wdNet.id] || 'Salva un indirizzo nel profilo';
  $('wdNets').innerHTML = NETS.map(n => `
    <button class="net ${n.id === wdNet.id ? 'active' : ''}" data-net="${n.id}">
      <b>${n.name}</b><small>USDT</small>
    </button>`).join('');
  document.querySelectorAll('#wdNets [data-net]').forEach(b => b.onclick = () => {
    wdNet = NETS.find(n => n.id === b.dataset.net);
    renderWithdraw();
  });
  $('wdHistoryTitle').hidden = state.withdrawals.length === 0;
  $('wdHistory').innerHTML = state.withdrawals.slice(0, 6).map(w => `
    <div class="wd-row">
      <div>
        <div class="wd-net">${w.net}</div>
        <div class="wd-sub">${new Date(w.date).toLocaleDateString('it-IT')} · ${statusLabel(w.status)}</div>
      </div>
      <div class="wd-amt">${fmt(w.amount)}</div>
    </div>`).join('');
  $('wdMsg').textContent = `Prelevabile fino a ${fmt(state.wallet.earnings)}.`;
}
$('wdAll').addEventListener('click', () => {
  $('wdAmount').value = state.wallet.earnings.toFixed(2);
});
$('wdBtn').addEventListener('click', async () => {
  const v = parseFloat($('wdAmount').value) || 0;
  if (v < 50) { $('wdAmount').focus(); $('wdMsg').textContent = 'Il prelievo minimo è di 50 USDT.'; return; }
  if (v > state.wallet.earnings + 1e-9) { $('wdMsg').textContent = `Importo non valido. Massimo prelevabile: ${fmt(state.wallet.earnings)}.`; return; }
  const address = (acc().withdraw_wallets || {})[wdNet.id];
  if (!address) { $('wdMsg').textContent = 'Salva prima un indirizzo di prelievo nel profilo.'; return; }
  if (!confirm(`Invii una richiesta di prelievo di ${fmt(v)} USDT su ${wdNet.name}? Dopo l’invio riceverai le istruzioni per attendere e inserire il codice OTP.`)) return;
  $('wdBtn').disabled = true;
  try {
    const result = await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ amount: v, net: wdNet.id }) });
    if (result.otpRequired) {
      await showSensitiveActionOtp(result);
      $('wdBtn').disabled = false;
      return;
    }
    await refresh();
    alert(`Richiesta di prelievo di ${fmt(v)} USDT inviata. L'importo è prenotato e verrà rimborsato se la richiesta sarà rifiutata.`);
    $('wdAmount').value = '';
    renderWithdraw(); renderHome(); renderProfile();
  } catch (e) {
    if (e.verificationRequired) showVerification(e.email, '', e.account || state.user.identifier, 'withdraw');
    else $('wdMsg').textContent = e.message;
  }
  $('wdBtn').disabled = false;
});

function activeInvestments() { return state.investments.filter(i => i.active); }
function investedActive() { return activeInvestments().reduce((a, i) => a + i.amount, 0); }
function invCard(i) {
  const el = (Date.now() - i.created) / DAY;
  const done = Math.min(1, el / i.days);
  return `
    <div class="ln-card">
      <div class="ln-top">
        <span class="ln-plan">${i.amount.toLocaleString('it-IT')} USDT · <span class="green">${i.rate.toLocaleString('it-IT')}%/gg</span></span>
        <span class="ln-status ${i.active ? 'active' : 'ended'}">${i.active ? 'Attivo' : 'Concluso'}</span>
      </div>
      <div class="ln-progress"><i style="width:${(done * 100).toFixed(0)}%"></i></div>
      <div class="ln-meta">
        <span>Maturato <b class="green">${fmt(cap(i))}</b></span>
        <span>${Math.min(Math.floor(el) + 1, i.days)}/${i.days} gg</span>
      </div>
      <div class="ln-meta" style="margin-top:4px">
        <span>Scadenza</span><b>${new Date(i.created + i.days * DAY).toLocaleDateString('it-IT')}</b>
      </div>
    </div>`;
}
function cap(i) {
  const elapsed = (Date.now() - i.created) / DAY;
  const days = Math.min(i.days, elapsed);
  return i.amount * i.rate / 100 * days;
}
function renderMy() {
  const act = activeInvestments();
  const closed = state.investments.filter(i => !i.active);
  $('activeSummary').innerHTML = `
    <div class="stat"><span>Investito</span><b>${fmtC(investedActive())}</b></div>
    <div class="stat"><span>Posizioni</span><b>${act.length}</b></div>
    <div class="stat"><span>Maturato</span><b>${fmtC(state.wallet.total_earned)}</b></div>`;
  $('investEmpty').hidden = act.length > 0;
  $('investList').innerHTML = act.map(invCard).join('');
  $('historyTitle').hidden = closed.length === 0;
  $('historyList').innerHTML = closed.map(invCard).join('');
}

function renderTeam() {
  const refs = state.team || [];
  const stats = state.inviteStats || { direct: 0, second: 0, level: 0, planBonus: 0 };
  const volume = refs.reduce((a, r) => a + r.invested, 0);
  const byLevel = { 1: [], 2: [], 3: [] };
  [...refs].sort((a, b) => a.level - b.level || b.joined - a.joined)
    .forEach(r => { if (byLevel[r.level]) byLevel[r.level].push(r); });
  const commByLevel = {};
  let commTotal = 0;
  LEVELS.forEach(l => {
    commByLevel[l.n] = byLevel[l.n].reduce((a, r) => a + r.commission_earned, 0);
    commTotal += commByLevel[l.n];
  });
  const target = stats.level === 0 ? 5 : stats.level === 1 ? 20 : stats.level === 2 ? 50 : 0;
  const progressCount = stats.level === 0 ? stats.direct : stats.level === 1 ? stats.second : stats.direct;
  const progressLabel = stats.level === 0 ? 'Invitati attivi diretti per il livello 1' : stats.level === 1 ? 'Invitati attivi di 2° livello per il livello 2' : stats.level === 2 ? 'Invitati attivi diretti per il livello 3' : 'Tutti i livelli raggiunti';
  const progressPct = target ? Math.min(100, progressCount / target * 100) : 100;
  $('teamSummary').innerHTML = `
    <div class="team-sum-grid">
      <div class="stat"><span>Membri totali</span><b>${refs.length}</b></div>
      <div class="stat"><span>Team attivo</span><b>${refs.filter(r => r.deposited && r.invested > 0).length}</b></div>
      <div class="stat"><span>Volume</span><b>${fmtC(volume)}</b></div>
      <div class="stat"><span>Commissioni</span><b>${fmtC(commTotal)}</b></div>
    </div>
    <div class="inviter-rank">
      <div class="rank-head">
        <div><span class="rank-kicker">IL TUO LIVELLO</span><b>Livello ${stats.level}</b></div>
        <div class="rank-current"><strong>+${stats.planBonus.toLocaleString('it-IT')}%</strong><small>bonus rendimento</small></div>
      </div>
      <div class="rank-progress">
        <div class="rank-progress-label"><span>${progressLabel}</span><b>${target ? Math.min(progressCount, target) + ' / ' + target : 'Completato'}</b></div>
        <div class="rank-track"><i style="width:${progressPct}%"></i></div>
      </div>
      <div class="rank-rewards"><span>Bonus piani</span><div><b>L1 <em>+0,05%</em></b><b>L2 <em>+0,15%</em></b><b>L3 <em>+0,33%</em></b></div></div>
    </div>`;
  $('teamLevels').innerHTML = LEVELS.map(l => `
    <div class="level-row">
      <span class="lv-badge">L${l.n}</span>
      <span class="lv-info"><b>Livello ${l.n}</b>
        <small>${byLevel[l.n].length} membro${byLevel[l.n].length === 1 ? '' : 'i'} · ${(l.pct * 100).toLocaleString('it-IT')}% sul primo deposito</small></span>
      <span class="lv-comms">${fmtC(commByLevel[l.n])}</span>
    </div>`).join('');
  $('teamCount').textContent = refs.length;
  $('teamList').innerHTML = LEVELS.map(l => {
    const members = byLevel[l.n];
    if (!members.length) return '';
    const contentId = 'teamLevel' + l.n + 'Members';
    return `<section class="tm-group">
      <button class="tm-group-toggle" type="button" aria-expanded="false" aria-controls="${contentId}">
        <span><b>Livello ${l.n}</b><small>${members.length} ${members.length === 1 ? 'membro' : 'membri'}</small></span>
        <svg class="team-toggle-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </button>
      <div class="tm-group-content" id="${contentId}" hidden>
        ${members.map(r => `
          <article class="tm-card">
            <img class="tm-ava" src="${avatar(r.username)}" alt="">
            <div class="tm-info">
              <b>${escapeHTML(r.username)}</b>
              <small>Iscritto il ${new Date(r.joined).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}</small>
              <small>${r.deposited && r.invested > 0 ? 'Attivo' : 'Non attivo'} · Investito ${fmt(r.invested)}</small>
            </div>
            <div class="tm-side">
              <span class="lv-badge lv-${r.level}">L${r.level}</span>
              <span class="tm-commission"><small>Commissioni</small><b>${fmt(r.commission_earned)}</b></span>
            </div>
          </article>`).join('')}
      </div>
    </section>`;
  }).join('') || '<div class="empty"><p>Condividi il tuo codice e invita i primi membri!</p></div>';
  $('teamList').hidden = true;
  $('teamMembersToggle').setAttribute('aria-expanded', 'false');
}

function sensitiveActionLabel(action) {
  return action === 'withdrawal' ? 'prelievo' : 'modifica wallet';
}
function sensitiveActionDetails(challenge) {
  const payload = challenge.payload || {};
  return challenge.action === 'withdrawal'
    ? 'Importo: ' + fmt(Number(payload.amount) || 0) + ' USDT · Rete: ' + (payload.net || '') + ' · Wallet: ' + (payload.address || '')
    : Object.entries(payload.wallets || {}).map(([net, address]) => net + ': ' + address).join(' · ');
}
function renderPendingAction() {
  const challenge = state?.sensitiveAction;
  const card = $('otpPendingCard');
  card.hidden = !challenge;
  if (!challenge) return;
  const actionLabel = sensitiveActionLabel(challenge.action);
  const now = Date.now();
  const issued = !!challenge.issuedAt && challenge.otpExpiresAt > now;
  const expired = !!challenge.issuedAt && challenge.otpExpiresAt <= now;
  $('otpPendingTitle').textContent = 'Richiesta OTP: ' + actionLabel;
  $('otpPendingMessage').textContent = issued
    ? 'Codice emesso. Controlla le notifiche dell’app o la tua email, poi inseriscilo qui.'
    : expired
      ? 'Il codice OTP è scaduto. Contatta l’assistenza per richiederne uno nuovo.'
      : 'Richiesta registrata. Invia l’email e attendi il codice OTP sull’app o via email.';
  $('otpPendingDetails').textContent = sensitiveActionDetails(challenge) + ' · Richiesta del ' + new Date(challenge.requestedAt).toLocaleString('it-IT');
  const email = state.user.identifier;
  const body = 'Richiesta OTP per ' + actionLabel + '\nNome utente: ' + state.user.username + '\nID account: ' + state.user.id + '\nEmail verificata: ' + email + '\nData richiesta: ' + new Date(challenge.requestedAt).toLocaleString('it-IT') + '\nDettagli: ' + sensitiveActionDetails(challenge) + '\n\nInviare un OTP di 6 cifre all’indirizzo email verificato dell’account.';
  $('otpPendingEmail').textContent = issued
    ? 'Non hai ricevuto il codice? Invia un’email all’assistenza'
    : expired
      ? 'Richiedi un nuovo codice OTP via email'
      : 'Invia email e attendi il codice OTP';
  $('otpPendingEmail').href = 'mailto:info.cup9@yahoo.com?subject=' + encodeURIComponent('Richiesta OTP ' + actionLabel) + '&body=' + encodeURIComponent(body);
  $('otpPendingEnter').hidden = !issued;
}
async function showSensitiveActionOtp(data) {
  state.sensitiveAction = { action: data.action, payload: data.payload, requestedAt: data.requestedAt, issuedAt: data.issuedAt || null, otpExpiresAt: data.otpExpiresAt || null };
  renderPendingAction();
  loadNotifications();
  $('otpPendingCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try { await refresh(); } catch {}
  if (!state?.sensitiveAction) {
    state.sensitiveAction = { action: data.action, payload: data.payload, requestedAt: data.requestedAt, issuedAt: data.issuedAt || null, otpExpiresAt: data.otpExpiresAt || null };
    renderPendingAction();
  }
}
function openSensitiveActionOtp() {
  const challenge = state?.sensitiveAction;
  if (!challenge) return;
  const actionLabel = sensitiveActionLabel(challenge.action);
  $('actionOtpDescription').textContent = 'Inserisci il codice OTP ricevuto per il ' + actionLabel + '. ' + sensitiveActionDetails(challenge);
  $('actionOtpInput').value = '';
  $('actionOtpError').textContent = '';
  $('actionOtpModal').dataset.action = challenge.action;
  $('actionOtpModal').hidden = false;
}
$('otpPendingEnter').addEventListener('click', openSensitiveActionOtp);
$('actionOtpClose').addEventListener('click', () => { $('actionOtpModal').hidden = true; });
$('actionOtpModal').addEventListener('click', event => {
  if (event.target === $('actionOtpModal')) $('actionOtpModal').hidden = true;
});
$('actionOtpForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('actionOtpForm').querySelector('button[type="submit"]');
  const error = $('actionOtpError');
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await api('/api/security/confirm-otp', { method: 'POST', body: JSON.stringify({ otp: $('actionOtpInput').value.trim() }) });
    const action = result.action;
    $('actionOtpModal').hidden = true;
    $('actionOtpInput').value = '';
    await refresh();
    if (action === 'withdrawal') {
      $('wdAmount').value = '';
      renderWithdraw(); renderHome(); renderProfile();
      $('wdMsg').textContent = 'OTP verificato. La richiesta di prelievo è stata inviata per revisione.';
    } else {
      renderProfile();
      if ($('walletMsg')) {
        $('walletMsg').textContent = 'OTP verificato. La richiesta di modifica wallet è stata inviata per revisione.';
        $('walletMsg').classList.remove('error');
      }
    }
  } catch (err) {
    error.textContent = err.message;
  }
  button.disabled = false;
});

$('teamMembersToggle').addEventListener('click', () => {
  const button = $('teamMembersToggle');
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  $('teamList').hidden = !open;
  if (!open) {
    $('teamList').querySelectorAll('.tm-group-toggle').forEach(toggle => {
      toggle.setAttribute('aria-expanded', 'false');
      $(toggle.getAttribute('aria-controls')).hidden = true;
    });
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('.tm-group-toggle');
  if (!button) return;
  const panel = $(button.getAttribute('aria-controls'));
  if (!panel) return;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
});

$('teamCopyLink').addEventListener('click', () => {
  const code = state.user.inviteCode;
  navigator.clipboard.writeText(code).catch(() => {
    const p = document.createElement('textarea');
    p.value = code; document.body.appendChild(p); p.select();
    document.execCommand('copy'); p.remove();
  });
  const b = $('teamCopyLink');
  b.textContent = 'Copiato';
  setTimeout(() => b.textContent = 'Copia', 1500);
});

const stateDefaults = {
  acc: { withdraw_wallets: {}, notifications: true },
  sensitiveAction: null,
};
function acc() { return Object.assign({}, stateDefaults.acc, state.acc || {}); }

function setNotifSwitch() {
  const checked = !!acc().notifications;
  const s = $('notifSwitch');
  s.classList.toggle('on', checked);
  s.setAttribute('aria-checked', String(checked));
}
function renderWalletPanel() {
  const wallets = acc().withdraw_wallets || {};
  const hasSavedWallet = NETS.some(n => wallets[n.id]);
  $('walletPanel').innerHTML = `
    <div class="wallet-nets">
      ${NETS.map(n => `
        <div class="wallet-net">
          <label>${n.name}${wallets[n.id] ? ' · Attuale' : ''}</label>
          <input type="text" data-net="${n.id}" autocomplete="off" placeholder="Indirizzo ${n.id}..." value="${(wallets[n.id] || '').replace(/"/g, '&quot;')}">
        </div>`).join('')}
      <button class="btn-primary" id="saveWallets">${hasSavedWallet ? 'Invia richiesta di modifica' : 'Salva wallet'}</button>
      <p class="hint" id="walletMsg">${hasSavedWallet ? 'Le modifiche saranno applicate solo dopo l’approvazione del proprietario o di un operatore.' : 'Dopo il primo salvataggio, ogni variazione richiede approvazione.'}</p>
    </div>`;
}
function renderHistPanel() {
  const rows = [];
  state.deposits.forEach(d => rows.push({ date: d.date, t: 'Deposito', net: d.net, amount: d.amount, status: d.status, plus: true }));
  state.withdrawals.forEach(w => rows.push({ date: w.date, t: 'Prelievo', net: w.net, amount: w.amount, status: w.status, plus: false }));
  rows.sort((a, b) => b.date - a.date);
  $('histPanel').innerHTML = (rows.length
    ? rows.map(r => `
        <div class="wd-row">
          <div>
            <div class="wd-net">${r.t} · ${r.net}</div>
            <div class="wd-sub">${new Date(r.date).toLocaleDateString('it-IT')} · ${statusLabel(r.status)}</div>
          </div>
          <div class="wd-amt ${r.plus ? 'green' : ''}" style="color:${r.plus ? 'var(--green)' : 'var(--accent-2)'}">${r.plus ? '+' : '−'}${fmt(r.amount)}</div>
        </div>`).join('')
    : '<div class="empty"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><p>Nessun movimento ancora.</p></div>');
}

async function renderAdminQueue(force = false, data = null, queueId = 'operatorQueue') {
  const queue = $(queueId);
  const active = document.activeElement;
  if (!force && queue.contains(active)) return;
  if (!queue.childElementCount) queue.innerHTML = '<div class="hint">Caricamento richieste…</div>';
  try {
    data ||= await api('/api/admin/transactions');
    if (queueId === 'ownerQueue' && !state?.isOwnerAccount) { queue.replaceChildren(); return; }
    const items = [
      ...data.deposits.map(r => ({ ...r, kind: 'deposit', title: 'Deposito' })),
      ...data.withdrawals.map(r => ({ ...r, kind: 'withdrawal', title: 'Prelievo' })),
      ...(data.walletChanges || []).map(r => ({ ...r, date: r.requested_at, kind: 'wallet_change', title: 'Modifica wallet' })),
    ].sort((a, b) => a.date - b.date);
    const verificationItems = data.emailVerifications || [];
    const actionVerificationItems = data.sensitiveActionVerifications || [];
    const passwordResetItems = data.passwordResets || [];

    if (!items.length && !verificationItems.length && !actionVerificationItems.length && !passwordResetItems.length) {
      const empty = '<div class="empty"><p>Nessuna richiesta in attesa.</p></div>';
      if (queue.innerHTML !== empty) queue.innerHTML = empty;
      return;
    }
    const verificationMarkup = verificationItems.map(r => {
      const status = r.issued_at && r.otp_expires_at > Date.now() ? 'OTP impostato' : 'In attesa OTP';
      return '<div class="ln-card review-card"><div class="ln-top"><b>Verifica email · ' + escapeHTML(r.username) + '</b><span class="ln-status active">' + status + '</span></div>' +
        '<div class="ln-meta"><span>' + escapeHTML(r.identifier) + '</span><span>' + new Date(r.requested_at).toLocaleString('it-IT') + '</span></div>' +
        '<div class="review-actions"><button class="btn-mini" type="button" data-admin-user="' + escapeHTML(r.user_id) + '">Visualizza richiesta / imposta OTP</button></div></div>';
    }).join('') + actionVerificationItems.map(r => {
      const action = r.action === 'withdrawal' ? 'Prelievo' : 'Modifica wallet';
      const status = r.issued_at && r.otp_expires_at > Date.now() ? 'OTP impostato' : 'In attesa OTP';
      return '<div class="ln-card review-card"><div class="ln-top"><b>OTP ' + action + ' · ' + escapeHTML(r.username) + '</b><span class="ln-status active">' + status + '</span></div>' +
        '<div class="ln-meta"><span>' + escapeHTML(r.identifier) + '</span><span>' + new Date(r.requested_at).toLocaleString('it-IT') + '</span></div>' +
        '<div class="review-actions"><button class="btn-mini" type="button" data-admin-user="' + escapeHTML(r.user_id) + '">Visualizza richiesta / imposta OTP</button></div></div>';
    }).join('') + passwordResetItems.map(r => {
      const status = r.issued_at && r.otp_expires_at > Date.now() ? 'OTP impostato' : 'In attesa OTP';
      return '<div class="ln-card review-card"><div class="ln-top"><b>Recupero password · ' + escapeHTML(r.username) + '</b><span class="ln-status active">' + status + '</span></div>' +
        '<div class="ln-meta"><span>' + escapeHTML(r.identifier) + '</span><span>' + new Date(r.requested_at).toLocaleString('it-IT') + '</span></div>' +
        '<div class="review-actions"><button class="btn-mini" type="button" data-admin-user="' + escapeHTML(r.user_id) + '">Visualizza richiesta / imposta OTP</button></div></div>';
    }).join('');

    const markup = verificationMarkup + items.map(r => {
      const heading = r.kind === 'wallet_change' ? r.title : r.title + ' · ' + fmt(r.amount);
      let html = '<div class="ln-card review-card"><div class="ln-top"><b>' + heading + '</b><span class="ln-status active">In verifica</span></div>';
      html += '<div class="ln-meta"><span>' + escapeHTML(r.username) + ' · ' + escapeHTML(r.net) + '</span><span>' + new Date(r.date).toLocaleString('it-IT') + '</span></div>';
      if (r.kind === 'withdrawal') html += '<div class="review-address">Destinazione: ' + escapeHTML(r.wallet_address) + '</div>';
      else if (r.kind === 'wallet_change') {
        const addrDetails = `Vecchio: ${r.old_address} -> Nuovo: ${r.new_address}`;
        html += '<div class="review-address">Account: ' + escapeHTML(r.identifier) + '<br>Rete: ' + escapeHTML(r.net) + '<br>' + escapeHTML(addrDetails) + '</div>';
      } else html += '<div class="review-address">TX: ' + escapeHTML(r.tx_reference) + '</div>';
      html += '<div class="review-actions"><button class="btn-mini" data-review="approve" data-kind="' + r.kind + '" data-id="' + r.id + '">Approva</button><button class="btn-mini reject" data-review="reject" data-kind="' + r.kind + '" data-id="' + r.id + '">Rifiuta</button></div></div>';
      return html;
    }).join('');
    if (queue.innerHTML !== markup) queue.innerHTML = markup;
  } catch (err) {
    if (queueId === 'operatorQueue' && (err.status === 401 || err.status === 403)) {
      await logoutOperator();
      $('loginErr').textContent = 'Sessione operatore scaduta. Inserisci di nuovo le credenziali.';
      return;
    }
    if (!queue.childElementCount || err.status === 401 || err.status === 403) {
      queue.innerHTML = '<p class="panel-msg error">' + escapeHTML(err.message) + '</p>';
    }
  }
}

document.addEventListener('click', async e => {
  const button = e.target.closest('[data-review]');
  if (!button) return;
  const action = button.dataset.review;
  const kind = button.dataset.kind;
  const id = Number(button.dataset.id);
  const queueId = button.closest('#ownerQueue') ? 'ownerQueue' : 'operatorQueue';
  if (!confirm((action === 'approve' ? 'Confermi l’approvazione' : 'Confermi il rifiuto') + ' della richiesta #' + id + '?')) return;
  button.disabled = true;
  try {
    await api('/api/admin/review', { method: 'POST', body: JSON.stringify({ action, kind, id }) });
    const data = await api('/api/admin/transactions');
    button.blur();
    await renderAdminQueue(true, data, queueId);
    await renderOperatorOverview();
  } catch (err) {
    alert(err.message);
    button.disabled = false;
  }
});

async function renderOperatorOverview() {
  let overviewContainer = $('operatorOverviewSection');
  if (!overviewContainer) {
    const main = document.querySelector('#operatorScreen .screen');
    if (main) {
      overviewContainer = document.createElement('section');
      overviewContainer.id = 'operatorOverviewSection';
      main.insertBefore(overviewContainer, main.firstChild);
    }
  }
  if (!overviewContainer) return;

  try {
    const { users } = await api('/api/admin/users');
    let totalDeposited = 0;
    let totalInvested = 0;
    let totalEarnings = 0;
    
    users.forEach(u => {
      totalDeposited += Number(u.wallet?.deposit || 0) + Number(u.wallet?.total_deposited || 0);
      totalEarnings += Number(u.wallet?.earnings || 0) + Number(u.wallet?.total_earned || 0);
    });

    overviewContainer.innerHTML = `
      <h2 class="section-title">Panoramica Piattaforma</h2>
      <div class="stats-grid" style="margin-bottom: 20px;">
        <div class="stat">Utenti registrati<span>${users.length}</span></div>
        <div class="stat">Depositi Totali<span>${fmt(totalDeposited)}</span></div>
        <div class="stat">Guadagni Totali<span>${fmt(totalEarnings)}</span></div>
      </div>
    `;
  } catch (err) {
    overviewContainer.innerHTML = '';
  }
}

$('adminCredentialSetup').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('adminCredentialEmail').value.trim();
  const input = $('adminNewSecret');
  const button = $('adminCredentialBtn');
  const password = input.value;
  $('adminAuthMsg').textContent = '';
  if (!email || password.length < 12) { $('adminAuthMsg').textContent = 'Inserisci un’email valida e una password di almeno 12 caratteri.'; return; }
  button.disabled = true;
  try {
    await api('/api/admin/credential', { method: 'POST', body: JSON.stringify({ email, password }) });
    input.value = '';
    $('adminAuthMsg').textContent = 'Credenziali operatore salvate. L’operatore può inserirle direttamente nei campi di accesso.';
    $('adminAuthMsg').classList.remove('error');
    await refresh();
    renderProfile(false);
  } catch (err) {
    $('adminAuthMsg').textContent = err.message;
    $('adminAuthMsg').classList.add('error');
  }
  button.disabled = false;
});

let cachedAdminUsers = [];
async function toggleAdminUsers(sectionId, listId, buttonId) {
  const section = $(sectionId);
  const button = $(buttonId);
  section.hidden = !section.hidden;
  button.textContent = section.hidden ? 'Utenti registrati' : 'Nascondi utenti';
  if (section.hidden) return;
  const list = $(listId);
  list.innerHTML = '<div class="hint">Caricamento utenti…</div>';
  try {
    const data = await api('/api/admin/users');
    cachedAdminUsers = data.users || [];
    if (sectionId === 'ownerUsersSection' && !state?.isOwnerAccount) { section.hidden = true; list.replaceChildren(); return; }
    renderAdminUsersList(listId, cachedAdminUsers);
  } catch (err) {
    list.innerHTML = '<p class="panel-msg error">' + escapeHTML(err.message) + '</p>';
  }
}

function renderAdminUsersList(listId, users) {
  const list = $(listId);
  list.innerHTML = users.length ? users.map(user =>
    '<div class="wd-row"><div><div class="wd-net"><button class="admin-user-link" type="button" data-admin-user="' + escapeHTML(user.id) + '">' + escapeHTML(user.username) +
    '</button></div><div class="wd-sub"><button class="admin-user-link" type="button" data-admin-user="' + escapeHTML(user.id) + '">' + escapeHTML(user.identifier) + '</button> · ' +
    (user.email_verified ? 'Email verificata' : 'Email da verificare') + ' · Iscritto il ' + new Date(user.created_at).toLocaleDateString('it-IT') + '</div></div></div>'
  ).join('') : '<div class="empty"><p>Nessun utente trovato.</p></div>';
}

document.addEventListener('input', e => {
  if (e.target.id === 'operatorUserSearch') {
    const query = e.target.value.trim().toLowerCase();
    const filtered = cachedAdminUsers.filter(u => 
      (u.username && u.username.toLowerCase().includes(query)) || 
      (u.identifier && u.identifier.toLowerCase().includes(query))
    );
    renderAdminUsersList('operatorUsersList', filtered);
  }
});

function adminVerificationMarkup(user, request) {
  let html = '<section class="admin-verification"><h3 class="block-title">Verifica email</h3>';
  html += '<p class="admin-user-contact">' + (user.email_verified ? 'Indirizzo verificato.' : 'Indirizzo non verificato.') + '</p>';
  if (request) {
    html += '<p class="admin-user-contact">Richiesta ricevuta il ' + new Date(request.requested_at).toLocaleString('it-IT') + '.</p>';
    if (request.issued_at && !request.verified_at) html += request.otp_expires_at > Date.now()
      ? '<p class="panel-msg">OTP impostato, valido fino al ' + new Date(request.otp_expires_at).toLocaleTimeString('it-IT') + '.</p>'
      : '<p class="panel-msg error">OTP scaduto. Impostane uno nuovo.</p>';
    if (request.verified_at) html += '<p class="panel-msg">Verifica completata il ' + new Date(request.verified_at).toLocaleString('it-IT') + '.</p>';
  } else if (!user.email_verified) {
    html += '<p class="hint">La richiesta OTP dell’utente non è ancora arrivata.</p>';
  }
  if (request && !request.verified_at && !user.email_verified) {
    html += '<form class="admin-otp-form" id="adminOtpForm"><label for="adminOtpInput">Imposta OTP a 6 cifre</label><input id="adminOtpInput" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button class="btn-primary" type="submit">Salva OTP</button><button class="btn-primary" type="submit" data-otp-notify="true">Salva e invia notifica</button><p class="panel-msg" id="adminOtpMsg" role="status"></p><a class="btn-primary mail-link" id="adminOtpEmailLink" hidden>Prepara email OTP</a></form>';
  }
  return html + '</section>';
}

function adminActionVerificationMarkup(request) {
  if (!request) return '';
  const action = request.action === 'withdrawal' ? 'prelievo' : 'modifica wallet';
  let details = '';
  try {
    const payload = JSON.parse(request.payload_json || '{}');
    details = request.action === 'withdrawal'
      ? '<p class="admin-user-contact">Importo: ' + fmt(payload.amount) + ' USDT · Rete: ' + escapeHTML(payload.net) + '<br>Wallet: ' + escapeHTML(payload.address) + '</p>'
      : '<p class="admin-user-contact">' + Object.entries(payload.wallets || {}).map(([net, address]) => escapeHTML(net) + ': ' + escapeHTML(address)).join('<br>') + '</p>';
  } catch {}
  const status = request.issued_at && request.otp_expires_at > Date.now()
    ? '<p class="panel-msg">OTP impostato, valido fino alle ' + new Date(request.otp_expires_at).toLocaleTimeString('it-IT') + '.</p>'
    : '<p class="panel-msg error">OTP da impostare.</p>';
  return '<section class="admin-verification"><h3 class="block-title">OTP per ' + action + '</h3>' +
    '<p class="admin-user-contact">Richiesto il ' + new Date(request.requested_at).toLocaleString('it-IT') + '.</p>' + details + status +
    '<form class="admin-otp-form" id="adminActionOtpForm"><label for="adminActionOtpInput">Imposta OTP a 6 cifre</label><input id="adminActionOtpInput" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button class="btn-primary" type="submit">Salva OTP</button><button class="btn-primary" type="submit" data-otp-notify="true">Salva e invia notifica</button><p class="panel-msg" id="adminActionOtpMsg" role="status"></p><a class="btn-primary mail-link" id="adminActionOtpEmailLink" hidden>Prepara email OTP</a></form></section>';
}

function adminPasswordResetMarkup(request) {
  if (!request) return '';
  const status = request.issued_at && request.otp_expires_at > Date.now()
    ? '<p class="panel-msg">OTP impostato, valido fino alle ' + new Date(request.otp_expires_at).toLocaleTimeString('it-IT') + '.</p>'
    : '<p class="panel-msg error">OTP da impostare.</p>';
  return '<section class="admin-verification"><h3 class="block-title">Recupero password</h3>' +
    '<p class="admin-user-contact">Richiesto il ' + new Date(request.requested_at).toLocaleString('it-IT') + '.</p>' + status +
    '<form class="admin-otp-form" id="adminPasswordResetOtpForm"><label for="adminPasswordResetOtpInput">Imposta OTP a 6 cifre</label><input id="adminPasswordResetOtpInput" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button class="btn-primary" type="submit">Salva OTP</button><button class="btn-primary" type="submit" data-otp-notify="true">Salva e invia notifica</button><p class="panel-msg" id="adminPasswordResetOtpMsg" role="status"></p><a class="btn-primary mail-link" id="adminPasswordResetEmailLink" hidden>Prepara email OTP</a></form></section>';
}

async function openAdminUser(userId) {
  const modal = $('adminUserModal');
  const detail = $('adminUserDetail');
  modal.dataset.userId = userId;
  modal.hidden = false;
  detail.innerHTML = '<p class="hint">Caricamento account…</p>';
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
    if (modal.dataset.userId !== userId) return;
    const { user, wallet, investments, verificationRequest, actionVerification, passwordResetRequest } = data;
    modal.dataset.userEmail = user.identifier;
    modal.dataset.actionType = actionVerification?.action || '';
    const invested = investments.reduce((sum, item) => sum + Number(item.amount), 0);
    detail.innerHTML = `
      <h2 id="adminUserTitle">${escapeHTML(user.username)}</h2>
      <p class="admin-user-contact">${escapeHTML(user.identifier)} · Account dal ${new Date(user.created_at).toLocaleDateString('it-IT')}</p>
      ${adminVerificationMarkup(user, verificationRequest)}
      ${adminActionVerificationMarkup(actionVerification)}
      ${adminPasswordResetMarkup(passwordResetRequest)}
      <div class="admin-user-stats">
        <div class="stat"><span>Saldo deposito</span><b>${fmt(wallet.deposit)}</b></div>
        <div class="stat"><span>Saldo guadagni</span><b>${fmt(wallet.earnings)}</b></div>
        <div class="stat"><span>Totale depositato</span><b>${fmt(wallet.total_deposited)}</b></div>
        <div class="stat"><span>Guadagni storici</span><b>${fmt(wallet.total_earned)}</b></div>
        <div class="stat"><span>Prelievi completati</span><b>${fmt(wallet.total_withdrawn)}</b></div>
        <div class="stat"><span>Totale investito</span><b>${fmt(invested)}</b></div>
      </div>
      <h3 class="block-title">Modifica saldi disponibili</h3>
      <form class="admin-balance-form" id="adminBalanceForm">
        <label>Saldo deposito (USDT)<input name="deposit" type="number" min="0" max="1000000000000" step="0.01" value="${Number(wallet.deposit).toFixed(2)}" required></label>
        <label>Saldo guadagni (USDT)<input name="earnings" type="number" min="0" max="1000000000000" step="0.01" value="${Number(wallet.earnings).toFixed(2)}" required></label>
        <button class="btn-primary" type="submit">Salva saldi</button>
        <p class="panel-msg" id="adminBalanceMsg" role="status">Le modifiche non alterano i totali storici.</p>
      </form>
      <h3 class="section-title">Investimenti (${investments.length})</h3>
      <div class="admin-investment-list">${investments.length ? investments.map(item => `
        <article class="admin-investment">
          <div class="ln-top"><b>${fmt(item.amount)} · ${Number(item.rate).toLocaleString('it-IT')}%/giorno</b><span class="ln-status ${item.active ? 'active' : 'ended'}">${item.active ? 'Attivo' : 'Concluso'}</span></div>
          <div class="ln-meta"><span>Piano ${item.days} giorni</span><span>Avvio ${new Date(item.created).toLocaleDateString('it-IT')}</span></div>
          <div class="ln-meta"><span>Guadagno maturato</span><b>${fmt(Number(item.amount) * Number(item.rate) / 100 * Number(item.credited))}</b></div>
        </article>`).join('') : '<p class="hint">Nessun investimento registrato.</p>'}</div>`;
  } catch (err) {
    if (modal.dataset.userId === userId) detail.innerHTML = `<p class="panel-msg error">${escapeHTML(err.message)}</p>`;
  }
}

async function deleteUser(userId) {
  if (!confirm("Sei sicuro di voler eliminare definitivamente questo utente e tutti i suoi dati (wallet, depositi, prelievi, investimenti)? L'operazione è irreversibile.")) {
    return;
  }
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/delete`, { method: 'POST' });
    alert("Utente eliminato con successo.");
    $('adminUserModal').hidden = true;
    if (!$('operatorUsersSection').hidden) {
      await toggleAdminUsers('operatorUsersSection', 'operatorUsersList', 'operatorUsersToggle');
      await toggleAdminUsers('operatorUsersSection', 'operatorUsersList', 'operatorUsersToggle');
    }
    if (!$('ownerUsersSection').hidden) {
      await toggleAdminUsers('ownerUsersSection', 'ownerUsersList', 'ownerUsersToggle');
      await toggleAdminUsers('ownerUsersSection', 'ownerUsersList', 'ownerUsersToggle');
    }
    await renderAdminQueue(true);
    await renderOperatorOverview();
  } catch (err) {
    alert("Errore: " + err.message);
  }
}

$('adminDeleteUserBtn')?.addEventListener('click', async () => {
  const userId = $('adminUserModal').dataset.userId;
  if (!userId) return;
  await deleteUser(userId);
});

document.addEventListener('click', e => {
  const userLink = e.target.closest('[data-admin-user]');
  if (userLink) openAdminUser(userLink.dataset.adminUser);
  if (e.target === $('adminUserModal') || e.target.closest('#adminUserClose')) $('adminUserModal').hidden = true;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('adminUserModal').hidden = true;
    $('actionOtpModal').hidden = true;
  }
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'adminOtpForm' || e.target.id === 'adminActionOtpForm') {
    e.preventDefault();
    const form = e.target;
    const buttons = [...form.querySelectorAll('button[type="submit"]')];
    const button = e.submitter || buttons[0];
    const notify = button.dataset.otpNotify === 'true';
    const msg = form.querySelector('.panel-msg');
    const userId = $('adminUserModal').dataset.userId;
    const email = $('adminUserModal').dataset.userEmail;
    const otp = form.elements.otp.value.trim();
    buttons.forEach(item => { item.disabled = true; });
    msg.textContent = notify ? 'Invio notifica OTP…' : 'Salvataggio OTP…';
    msg.classList.remove('error');
    try {
      const result = await api('/api/admin/users/' + encodeURIComponent(userId) + '/verification-otp', { method: 'POST', body: JSON.stringify({ otp, notify }) });
      const expiry = new Date(result.expiresAt);
      const actionType = $('adminUserModal').dataset.actionType;
      const actionLabel = actionType === 'withdrawal' ? 'richiesta di prelievo' : actionType === 'wallet_change' ? 'modifica del wallet' : 'verifica email';
      const body = 'Il tuo codice OTP per autorizzare la ' + actionLabel + ' è: ' + otp + '\n\nIl codice scade alle ' + expiry.toLocaleString('it-IT') + '. Se non hai richiesto questa operazione, contatta il supporto.';
      const link = form.querySelector('.mail-link');
      if (notify) {
        if (link) link.hidden = true;
        msg.textContent = 'OTP inviato nella campana notifiche dell’utente. Valido per 15 minuti.';
      } else {
        if (link) {
          link.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Codice OTP ' + actionLabel) + '&body=' + encodeURIComponent(body);
          link.hidden = false;
        }
        msg.textContent = 'OTP salvato. Ora prepara e invia manualmente l’email all’utente.';
      }
      buttons.forEach(item => { item.disabled = false; });
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('error');
      buttons.forEach(item => { item.disabled = false; });
    }
    return;
  }

  if (e.target.id === 'adminPasswordResetOtpForm') {
    e.preventDefault();
    const form = e.target;
    const buttons = [...form.querySelectorAll('button[type="submit"]')];
    const button = e.submitter || buttons[0];
    const notify = button.dataset.otpNotify === 'true';
    const msg = $('adminPasswordResetOtpMsg');
    const userId = $('adminUserModal').dataset.userId;
    const email = $('adminUserModal').dataset.userEmail;
    const otp = form.elements.otp.value.trim();
    buttons.forEach(item => { item.disabled = true; });
    msg.textContent = notify ? 'Invio notifica OTP…' : 'Salvataggio OTP…';
    msg.classList.remove('error');
    try {
      const result = await api('/api/admin/users/' + encodeURIComponent(userId) + '/password-reset-otp', { method: 'POST', body: JSON.stringify({ otp, notify }) });
      const expiry = new Date(result.expiresAt);
      const body = 'Il tuo codice OTP per il recupero della password è: ' + otp + '\n\nIl codice scade alle ' + expiry.toLocaleString('it-IT') + '. Se non hai richiesto questa operazione, contatta il supporto.';
      const link = $('adminPasswordResetEmailLink');
      if (notify) {
        if (link) link.hidden = true;
        msg.textContent = 'OTP inviato nella campana notifiche dell’utente. Valido per 15 minuti.';
      } else {
        if (link) {
          link.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Codice OTP recupero password') + '&body=' + encodeURIComponent(body);
          link.hidden = false;
        }
        msg.textContent = 'OTP salvato. Ora prepara e invia manualmente l’email all’utente.';
      }
      buttons.forEach(item => { item.disabled = false; });
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('error');
      buttons.forEach(item => { item.disabled = false; });
    }
    return;
  }

  if (e.target.id !== 'adminBalanceForm') return;
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const msg = $('adminBalanceMsg');
  const userId = $('adminUserModal').dataset.userId;
  const deposit = form.elements.deposit.value;
  const earnings = form.elements.earnings.value;
  if (deposit === '' || earnings === '') { msg.textContent = 'Inserisci entrambi i saldi.'; msg.classList.add('error'); return; }
  button.disabled = true;
  msg.textContent = 'Salvataggio…';
  msg.classList.remove('error');
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/balance`, { method: 'POST', body: JSON.stringify({ deposit: Number(deposit), earnings: Number(earnings) }) });
    await openAdminUser(userId);
    const updatedMsg = $('adminBalanceMsg');
    updatedMsg.textContent = 'Saldi aggiornati.';
    await renderOperatorOverview();
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('error');
    button.disabled = false;
  }
});

$('operatorUsersToggle').addEventListener('click', () => toggleAdminUsers('operatorUsersSection', 'operatorUsersList', 'operatorUsersToggle'));
$('ownerUsersToggle').addEventListener('click', () => toggleAdminUsers('ownerUsersSection', 'ownerUsersList', 'ownerUsersToggle'));
$('operatorLogoutBtn').addEventListener('click', logoutOperator);

function renderProfile(updatePanels = true) {
  const editing = $('view-profile').contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
  $('adminAccessSection').hidden = !state.isOwner;
  $('adminCredentialSetup').hidden = !state.isOwner;
  $('ownerRequestSection').hidden = !state.isOwnerAccount;
  if (state.isOwnerAccount) {
    renderAdminQueue(false, null, 'ownerQueue');
  } else {
    $('ownerQueue').replaceChildren();
    $('ownerUsersSection').hidden = true;
    $('ownerUsersToggle').textContent = 'Utenti registrati';
    $('ownerUsersList').replaceChildren();
    $('adminUserModal').hidden = true;
    $('adminUserModal').dataset.userId = '';
    $('adminUserDetail').replaceChildren();
  }
  $('statEarned').textContent = fmtC(state.wallet.total_earned);
  $('statWd').textContent = fmtC(state.wallet.total_withdrawn);
  $('statDep').textContent = fmtC(state.wallet.deposit);
  $('statReferrals').textContent = state.team.length;

  const wallets = acc().withdraw_wallets || {};
  const saved = NETS.filter(n => wallets[n.id]).length;
  $('walletStatus').textContent = saved > 0
    ? `${saved}/${NETS.length} rete${saved === 1 ? '' : 'e'} salvate`
    : 'Nessun indirizzo salvato';
  setNotifSwitch();
  if (updatePanels && !editing && !$('histPanel').hidden) renderHistPanel();
}

document.querySelectorAll('.acc-row').forEach(row => {
  row.addEventListener('click', () => {
    const panel = $(row.dataset.panel);
    const open = !panel.hidden;
    panel.hidden = open;
    row.classList.toggle('open', !open);
    if (!open) {
      if (panel === $('walletPanel')) renderWalletPanel();
      if (panel === $('histPanel')) renderHistPanel();
    }
  });
});

document.addEventListener('click', async e => {
  if (e.target.id !== 'saveWallets') return;
  const wallets = {};
  document.querySelectorAll('#walletPanel [data-net]').forEach(i => {
    wallets[i.dataset.net] = i.value.trim();
  });
  const changing = NETS.some(n => acc().withdraw_wallets?.[n.id]);
  const btn = e.target; btn.disabled = true;
  try {
    const result = await api(changing ? '/api/wallet-change-request' : '/api/save-wallet', { method: 'POST', body: JSON.stringify({ wallets }) });
    if (changing && result.otpRequired) {
      await showSensitiveActionOtp(result);
      btn.disabled = false;
      return;
    }
    await refresh();
    renderProfile();
    if (changing) {
      $('walletMsg').textContent = 'Richiesta inviata. Gli indirizzi attuali restano attivi fino alla revisione.';
      btn.disabled = false;
    } else if (!$('walletPanel').hidden) renderWalletPanel();
  } catch (err) {
    if (err.verificationRequired) showVerification(err.email, '', err.account || state.user.identifier, 'profile');
    else {
      $('walletMsg').textContent = err.message;
      $('walletMsg').classList.add('error');
    }
    btn.disabled = false;
  }
});

$('notifSwitch').addEventListener('click', async () => {
  const next = !acc().notifications;
  const s = $('notifSwitch');
  s.classList.toggle('on', next); s.setAttribute('aria-checked', next);
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ notifications: next }) }); await refresh(); }
  catch (err) { alert(err.message); setNotifSwitch(); }
});

$('pwSave').addEventListener('click', async () => {
  const cur = $('pwCur').value;
  const nw = $('pwNew').value;
  const nw2 = $('pwNew2').value;
  $('pwMsg').textContent = '';
  if (!cur || !nw) { $('pwMsg').textContent = 'Compila tutti i campi.'; $('pwMsg').style.color = 'var(--red)'; return; }
  if (nw.length < 6) { $('pwMsg').textContent = 'La nuova password deve avere almeno 6 caratteri.'; $('pwMsg').style.color = 'var(--red)'; return; }
  if (nw !== nw2) { $('pwMsg').textContent = 'Le password non coincidono.'; $('pwMsg').style.color = 'var(--red)'; return; }
  $('pwSave').disabled = true;
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({ current: cur, next: nw }) });
    $('pwCur').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
    $('pwMsg').style.color = 'var(--green)';
    $('pwMsg').textContent = 'Password aggiornata con successo.';
    setTimeout(() => { $('pwMsg').textContent = ''; }, 4000);
  } catch (err) { $('pwMsg').style.color = 'var(--red)'; $('pwMsg').textContent = err.message; }
  $('pwSave').disabled = false;
});

// ---------- Gestione Auth / Password Dimenticata ----------
let verificationReturnView = '';
function hideAuthMsg() { const m = $('authMsg'); m.hidden = true; m.textContent = ''; }
function resetAuthTabs() {
  hideAuthMsg();
  $('tabLogin').hidden = false;
  $('tabRegister').hidden = false;
  $('verificationPanel').hidden = true;
  $('passwordRecoveryPanel').hidden = true;
  $('authTabsContainer').hidden = false;
  $('tabLogin').classList.add('active');
  $('tabRegister').classList.remove('active');
  $('loginForm').hidden = false;
  $('registerForm').hidden = true;
  $('verificationRequestMsg').textContent = '';
  $('requestEmailLink').hidden = true;
}

$('forgotPasswordBtn').addEventListener('click', () => {
  hideAuthMsg();
  $('tabLogin').hidden = true;
  $('tabRegister').hidden = true;
  $('authTabsContainer').hidden = true;
  $('loginForm').hidden = true;
  $('registerForm').hidden = true;
  $('verificationPanel').hidden = true;
  $('passwordRecoveryPanel').hidden = false;
  $('recoveryEmail').value = '';
  $('recoveryRequestErr').textContent = '';
  $('recoveryConfirmErr').textContent = '';
  $('recoveryRequestMsg').textContent = '';
  $('recoveryEmailLink').hidden = true;
  $('recoveryConfirmForm').hidden = true;
});

$('recoveryBack').addEventListener('click', resetAuthTabs);

$('recoveryRequestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('recoveryEmail').value.trim().toLowerCase();
  const error = $('recoveryRequestErr');
  const link = $('recoveryEmailLink');
  error.textContent = '';
  link.hidden = true;
  try {
    const data = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    const body = 'Richiesta recupero password\nEmail account: ' + data.email + '\nData richiesta: ' + new Date(data.requestedAt).toLocaleString('it-IT') + '\n\nRichiedo l’invio di un codice OTP per reimpostare la mia password.';
    link.href = 'mailto:info.cup9@yahoo.com?subject=' + encodeURIComponent('Richiesta OTP recupero password') + '&body=' + encodeURIComponent(body);
    link.hidden = false;
    $('recoveryRequestMsg').textContent = 'Richiesta registrata nel pannello operatore. Invia la mail e attendi l’emissione del codice OTP.';
    $('recoveryConfirmForm').hidden = false;
  } catch (err) { error.textContent = err.message; }
});

$('recoveryConfirmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('recoveryConfirmErr');
  error.textContent = '';
  const email = $('recoveryEmail').value.trim().toLowerCase();
  const otp = $('recoveryOtp').value.trim();
  const newPassword = $('recoveryNewPass').value;
  if (newPassword.length < 6) { error.textContent = 'La password deve avere almeno 6 caratteri.'; return; }
  try {
    const result = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, otp, newPassword }) });
    alert(result.message || 'Password reimpostata con successo. Ora puoi effettuare il login.');
    resetAuthTabs();
    $('loginId').value = email;
  } catch (err) { error.textContent = err.message; }
});

function showVerification(email, password = '', account = '', returnView = '') {
  verificationReturnView = returnView;
  if (returnView) {
    $('authScreen').hidden = false;
    $('appBody').hidden = true;
    $('operatorScreen').hidden = true;
  }
  hideAuthMsg();
  $('tabLogin').hidden = true;
  $('tabRegister').hidden = true;
  $('authTabsContainer').hidden = true;
  $('loginForm').hidden = true;
  $('registerForm').hidden = true;
  $('verificationPanel').hidden = false;
  $('verifyEmail').value = email || '';
  $('verifyAccount').value = account || email || '';
  $('verifyPassword').value = password;
  $('verificationRequestErr').textContent = '';
  $('verificationConfirmErr').textContent = '';
  $('verificationRequestMsg').textContent = '';
  $('requestEmailLink').hidden = true;
}
$('tabLogin').addEventListener('click', resetAuthTabs);
$('tabRegister').addEventListener('click', () => {
  hideAuthMsg();
  $('tabLogin').classList.remove('active');
  $('tabRegister').classList.add('active');
  $('loginForm').hidden = true;
  $('registerForm').hidden = false;
});
$('verificationBack').addEventListener('click', () => {
  if (verificationReturnView) {
    const destination = verificationReturnView;
    verificationReturnView = '';
    $('authScreen').hidden = true;
    $('appBody').hidden = false;
    resetAuthTabs();
    go(destination);
    return;
  }
  resetAuthTabs();
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('regId').value.trim().toLowerCase();
  const username = $('regUser').value.trim();
  const password = $('regPass').value;
  const invite = $('regInvite').value.trim();
  $('regErr').textContent = '';
  if (!email || !username || !password) { $('regErr').textContent = 'Compila tutti i campi.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('regErr').textContent = 'Inserisci un indirizzo email valido.'; return; }
  if (password.length < 6) { $('regErr').textContent = 'Password di almeno 6 caratteri.'; return; }
  if (password !== $('regPass2').value) { $('regErr').textContent = 'Le password non coincidono.'; return; }
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({ identifier: email, username, password, invite }) });
    $('registerForm').reset();
    resetAuthTabs();
    $('loginId').value = email;
    $('loginPass').value = '';
    $('authMsg').textContent = 'Account creato. Puoi accedere subito; la verifica email è necessaria per prelievi e modifiche wallet.';
    $('authMsg').hidden = false;
  } catch (err) { $('regErr').textContent = err.message; }
});

$('verificationRequestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('verifyEmail').value.trim().toLowerCase();
  const password = $('verifyPassword').value;
  const error = $('verificationRequestErr');
  const link = $('requestEmailLink');
  error.textContent = '';
  link.hidden = true;
  try {
    const data = await api('/api/verification/request', { method: 'POST', body: JSON.stringify({ account: $('verifyAccount').value.trim(), email, password }) });
    $('verifyAccount').value = data.email;
    $('verifyEmail').value = data.email;
    const body = 'Richiesta di verifica email\nNome utente: ' + data.username + '\nID account: ' + data.userId + '\nAccount usato: ' + data.email + '\nEmail da verificare: ' + data.email + '\nData richiesta: ' + new Date(data.requestedAt).toLocaleString('it-IT') + '\n\nRichiedo l’invio di un OTP per verificare il mio indirizzo email.';
    link.href = 'mailto:info.cup9@yahoo.com?subject=' + encodeURIComponent('Richiesta OTP verifica email') + '&body=' + encodeURIComponent(body);
    link.hidden = false;
    $('verificationRequestMsg').textContent = data.alreadyRequested
      ? 'La richiesta è già presente nel pannello. Puoi riaprire la bozza email.'
      : 'Richiesta registrata nel pannello. Il servizio email non è collegato: apri e invia la bozza al gestore.';
  } catch (err) { error.textContent = err.message; }
});

$('verificationConfirmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('verificationConfirmErr');
  error.textContent = '';
  try {
    const result = await api('/api/verification/confirm', { method: 'POST', body: JSON.stringify({ email: $('verifyEmail').value.trim(), password: $('verifyPassword').value, otp: $('verifyOtp').value.trim() }) });
    token = result.token;
    localStorage.setItem(TOKEN_KEY, token);
    $('verifyOtp').value = '';
    const destination = verificationReturnView;
    verificationReturnView = '';
    await refresh();
    enterApp();
    if (destination) go(destination);
  } catch (err) { error.textContent = err.message; }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('loginId').value.trim();
  const password = $('loginPass').value;
  $('loginErr').textContent = '';
  if (!id || !password) { $('loginErr').textContent = 'Inserisci email e password.'; return; }
  try {
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ id, password }) });
    if (res.mode === 'operator') {
      adminToken = res.token;
      localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
      const data = await api('/api/admin/transactions');
      await enterOperator(data);
      return;
    }
    adminToken = null;
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    token = res.token;
    localStorage.setItem(TOKEN_KEY, token);
    await refresh();
    enterApp();
  } catch (err) {
    if (adminToken) {
      adminToken = null;
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
    $('loginErr').textContent = err.message;
  }
});

$('logoutBtn').addEventListener('click', () => logout());

(async function boot() {
  if (adminToken) {
    try {
      const data = await api('/api/admin/transactions');
      await enterOperator(data);
      return;
    } catch (e) {
      adminToken = null;
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  }
  if (token) {
    try {
      await refresh();
      enterApp();
      return;
    } catch (e) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  $('authScreen').hidden = false;
  $('appBody').hidden = true;
})();

setInterval(async () => {
  if (adminToken && !$('operatorScreen').hidden && document.visibilityState === 'visible') {
    await renderAdminQueue();
    await renderOperatorOverview();
    return;
  }
  if (token && state?.isOwnerAccount && $('view-profile').classList.contains('active') && document.visibilityState === 'visible') {
    await renderAdminQueue(false, null, 'ownerQueue');
  }
  if (!token || !state || document.visibilityState !== 'visible') return;
  try {
    await refresh();
    if ($('view-home').classList.contains('active')) renderHome();
    if ($('view-my').classList.contains('active')) renderMy();
    if ($('view-withdraw').classList.contains('active')) renderWithdraw();
    if ($('view-profile').classList.contains('active')) {
      renderProfile(false);
    }
  } catch (e) {}
}, 15000);

window.addEventListener('pagehide', () => {
  if (!token && !adminToken) return;
  const body = JSON.stringify({ sessionToken: token, adminToken });
  const payload = new Blob([body], { type: 'application/json' });
  if (!navigator.sendBeacon('/api/logout', payload)) {
    fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
});
