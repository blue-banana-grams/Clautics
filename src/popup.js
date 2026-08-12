// Clautics — src/popup.js
'use strict';

// Labels, tier names, percentage severity, countdown and date-key formatting,
// and the peak-hours heuristic all live in common.js — loaded just above this
// file — because the on-page panel needs exactly the same logic.

const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FREE_DAYS  = 7;

// ── Helpers ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// Lighter shade the bar fades in from, per severity.
const GRADIENT_FROM = { warn: '#f07a70', caution: '#e8b870', accent: '#e09878' };

// ── Pro state ─────────────────────────────────────────────────────────────

let isPro = false;
let currentDailyUsage = {};

async function loadProStatus() {
  const { isPro: stored } = await chrome.storage.local.get('isPro');
  isPro = !!stored;
  applyProUI();
}

// Everything gated behind Pro, shown/hidden together.
const PRO_SECTIONS = ['custom-alerts-section', 'breakdown-section', 'export-section', 'year-section'];

function applyProUI() {
  $('proBadge').style.display = isPro ? 'inline-block' : 'none';
  $('upgrade-banner').classList.toggle('show', !isPro);
  $('buy-section').style.display = isPro ? 'none' : 'block';
  for (const id of PRO_SECTIONS) $(id).style.display = isPro ? 'block' : 'none';

  $('license-activate-section').style.display   = isPro ? 'none' : 'block';
  $('license-deactivate-section').style.display = isPro ? 'block' : 'none';
  $('pro-status-icon').textContent  = isPro ? '✅' : '🔓';
  $('pro-status-label').textContent = isPro ? 'Pro — unlocked' : 'Free plan';
  $('pro-status-sub').textContent   = isPro
    ? 'Full year history · export · all features'
    : '7-day history · basic stats';

  // Re-render with the correct gating
  renderYearHeatmap(currentDailyUsage);
  if (isPro) renderBreakdown(currentDailyUsage);
}

// ── View switching ────────────────────────────────────────────────────────

let currentView = 'main';

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
  $('refreshBtn').style.display = name === 'main' ? 'flex' : 'none';
  $('settingsBtn').textContent  = name === 'settings' ? '←' : '⚙';
}

$('settingsBtn').addEventListener('click', () => {
  showView(currentView === 'settings' ? 'main' : 'settings');
});
$('upgrade-banner').addEventListener('click', () => showView('settings'));

// ── License ───────────────────────────────────────────────────────────────

const licenseInput = $('licenseInput');
const activateBtn  = $('activateBtn');
const licenseMsg   = $('licenseMsg');

function showLicenseMsg(text, type) {
  licenseMsg.textContent = text;
  licenseMsg.className   = `license-msg show ${type}`;
}

activateBtn.addEventListener('click', async () => {
  const key = licenseInput.value.trim();
  if (!key) { showLicenseMsg('Please enter your license key.', 'fail'); return; }
  activateBtn.disabled    = true;
  activateBtn.textContent = 'Checking…';
  licenseInput.className  = 'license-input';
  licenseMsg.className    = 'license-msg';
  chrome.runtime.sendMessage({ type: 'clautics_activate', key }, ({ valid, error }) => {
    activateBtn.disabled    = false;
    activateBtn.textContent = 'Activate';
    if (valid) {
      isPro = true;
      licenseInput.className = 'license-input valid';
      showLicenseMsg('✓ Pro unlocked! All features are now active.', 'success');
      applyProUI();
    } else {
      licenseInput.className = 'license-input error';
      showLicenseMsg(error || 'Invalid key — check your email from Lemon Squeezy.', 'fail');
    }
  });
});

licenseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') activateBtn.click(); });

$('deactivateBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ licenseKey: null, licenseInstanceId: null, isPro: false, licenseCheckedAt: null });
  isPro = false;
  licenseInput.value = '';
  licenseInput.className = 'license-input';
  licenseMsg.className   = 'license-msg';
  applyProUI();
});

// ── Custom alert thresholds ───────────────────────────────────────────────

const saveThresholdsBtn = $('saveThresholdsBtn');

// Load saved values
chrome.storage.local.get(['alertWarnPct', 'alertCritPct'], (r) => {
  if (r.alertWarnPct) $('threshWarn').value = r.alertWarnPct;
  if (r.alertCritPct) $('threshCrit').value = r.alertCritPct;
});

saveThresholdsBtn.addEventListener('click', () => {
  const warn = Math.min(99,  Math.max(1, parseInt($('threshWarn').value) || 80));
  const crit = Math.min(100, Math.max(1, parseInt($('threshCrit').value) || 95));
  chrome.storage.local.set({ alertWarnPct: warn, alertCritPct: crit, alertsSent: {} }, () => {
    saveThresholdsBtn.textContent = '✓ Saved';
    saveThresholdsBtn.classList.add('saved');
    setTimeout(() => {
      saveThresholdsBtn.textContent = 'Save thresholds';
      saveThresholdsBtn.classList.remove('saved');
    }, 2000);
  });
});

// ── On-page panel size preset ────────────────────────────────────────────

const PANEL_SIZE_KEY = 'cly_panel_width';

function setActivePanelSizeButton(size) {
  document.querySelectorAll('#panelSizeOptions button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
}

chrome.storage.local.get(PANEL_SIZE_KEY, (r) => {
  setActivePanelSizeButton(r[PANEL_SIZE_KEY] || 'default');
});

document.querySelectorAll('#panelSizeOptions button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.size;
    setActivePanelSizeButton(size);
    chrome.storage.local.set({ [PANEL_SIZE_KEY]: size });
    chrome.tabs.query({ url: '*://claude.ai/*' }, (tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'clautics_panel_size', size }).catch(() => {});
    });
  });
});

// ── Limits ────────────────────────────────────────────────────────────────

function renderLimits(limits) {
  const container = $('limits');
  if (!limits) { container.innerHTML = '<div class="empty">No data yet.<br>Open claude.ai first.</div>'; return; }

  // CLY.ORDER is already the display order, so selecting by it sorts for free.
  const entries = CLY.ORDER.map((key) => [key, limits[key]]).filter(([, v]) => v != null);
  if (!entries.length) { container.innerHTML = '<div class="empty">No active limits found.</div>'; return; }

  const frag = document.createDocumentFragment();
  for (const [key, limit] of entries) {
    const pct   = limit.pct ?? 0;
    const level = CLY.level(pct);
    const color = `var(--${level})`;

    const row = document.createElement('div'); row.className = 'lrow';
    const top = document.createElement('div'); top.className = 'lrow-top';

    // Colored dot indicator
    const dot = document.createElement('span');
    dot.className = 'lrow-dot';
    dot.style.backgroundColor = color;

    const label = document.createElement('span'); label.className = 'lrow-label';
    label.append(dot, CLY.LABELS[key] || key);

    const pctEl = document.createElement('span'); pctEl.className = 'lrow-pct';
    pctEl.style.color = color;
    pctEl.textContent = `${pct.toFixed(0)}%`;

    const right = document.createElement('div'); right.className = 'lrow-right';
    right.appendChild(pctEl);
    top.append(label, right);

    const resetEl = document.createElement('span'); resetEl.className = 'lrow-reset';
    if (key === 'extraUsage' && limit.usedCents != null) {
      resetEl.textContent = `$${(limit.usedCents / 100).toFixed(2)} / $${(limit.limitCents / 100).toFixed(2)}`;
    } else if (limit.resetsAt) {
      resetEl.dataset.ts  = limit.resetsAt;
      resetEl.textContent = `↺ ${CLY.countdown(limit.resetsAt)}`;
    }

    const track = document.createElement('div'); track.className = 'track';
    const fill  = document.createElement('div'); fill.className = 'fill';
    // Explicit backgroundColor so there's no CSS specificity conflict, then a
    // gradient on top for the "color-coded" visual the website promises.
    fill.style.backgroundColor = color;
    fill.style.backgroundImage = pct > 5 ? `linear-gradient(to right, ${GRADIENT_FROM[level]}, ${color})` : 'none';
    fill.style.width = `${Math.min(pct, 100)}%`;
    track.appendChild(fill);

    row.append(top, track);
    if (resetEl.textContent) row.appendChild(resetEl);
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

// ── Daily stats pills ─────────────────────────────────────────────────────

function renderDailyStats(dailyUsage) {
  const du = dailyUsage || {};
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const todayVal = du[CLY.dateKey(today)] || 0;

  // Streak (consecutive days ending today with >0) and the 30-day average come
  // out of one backward walk over a single Date cursor, and it stops as soon as
  // both answers are settled — the old code allocated up to 395 Date objects
  // and always scanned the full window even when the streak broke on day one.
  const cur = new Date(today);
  let streak = 0, counting = true, sum = 0, n = 0;
  for (let i = 0; i < 365; i++) {
    const v = du[CLY.dateKey(cur)] || 0;
    if (counting) { if (v > 0) streak++; else counting = false; }
    if (i < 30 && v > 0) { sum += v; n++; }
    if (!counting && i >= 29) break;
    cur.setDate(cur.getDate() - 1);
  }
  const avg = n ? sum / n : 0;

  $('stat-today').textContent = todayVal > 0 ? todayVal : '—';
  $('stat-streak').innerHTML  = streak > 0 ? `${streak}<span class="fire"> 🔥</span>` : '—';
  $('stat-avg').textContent   = avg > 0 ? avg.toFixed(1) : '—';
}

// ── 7-day bar chart ───────────────────────────────────────────────────────

function render7DayChart(dailyUsage) {
  const du = dailyUsage || {};
  const cur = new Date(); cur.setHours(0, 0, 0, 0);
  cur.setDate(cur.getDate() - 6);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const key = CLY.dateKey(cur);
    days.push({ key, dow: cur.getDay(), val: du[key] || 0, isToday: i === 6 });
    cur.setDate(cur.getDate() + 1);
  }
  const maxVal = Math.max(...days.map(d => d.val), 1);

  const frag = document.createDocumentFragment();
  for (const { key, dow, val, isToday } of days) {
    const col = document.createElement('div');
    col.className = 'chart-col';
    col.title = `${key}: ${val > 0 ? val + ' msg' : 'no messages'}`;

    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';

    const bar = document.createElement('div');
    bar.className = isToday ? 'chart-bar today' : val > 0 ? 'chart-bar past-active' : 'chart-bar past';
    bar.style.height = `${Math.max((val / maxVal) * 100, val > 0 ? 6 : 3)}%`;
    wrap.appendChild(bar);

    const dayLbl = document.createElement('div');
    dayLbl.className   = 'chart-day-lbl';
    dayLbl.textContent = isToday ? 'Today' : DAYS_SHORT[dow];

    const countLbl = document.createElement('div');
    countLbl.className   = `chart-count-lbl${val === 0 ? ' zero' : ''}`;
    countLbl.textContent = val > 0 ? String(val) : '—';

    col.append(wrap, dayLbl, countLbl);
    frag.appendChild(col);
  }
  $('seven-day-chart').replaceChildren(frag);
}

// ── Year heatmap ──────────────────────────────────────────────────────────

function renderYearHeatmap(dailyUsage) {
  const container = $('daily-usage');
  const du = dailyUsage || {};

  const today = new Date(); today.setHours(0,0,0,0);
  const freeCutoff = new Date(today); freeCutoff.setDate(freeCutoff.getDate() - FREE_DAYS + 1);

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  startDate.setDate(startDate.getDate() - startDate.getDay()); // align to Sunday

  const totalDays  = Math.round((today - startDate) / 86_400_000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  const maxVal = Math.max(...Object.values(du).filter(Number.isFinite), 0.001);

  function cellColor(val, locked) {
    if (locked || !val || val <= 0) return 'var(--bg3)';
    const r = Math.min(val / maxVal, 1);
    if (r < 0.2)  return 'rgba(204,120,92,0.2)';
    if (r < 0.4)  return 'rgba(204,120,92,0.4)';
    if (r < 0.65) return 'rgba(204,120,92,0.65)';
    if (r < 0.85) return 'rgba(204,120,92,0.85)';
    return '#cc785c';
  }

  // One forward walk over a single Date cursor builds both the cells and the
  // month-label row. The old version re-derived every date with a fresh
  // `new Date()` in two separate nested loops (≈750 allocations) and then did
  // a linear scan of a spread Map per column to find each label.
  const monthLabels = new Array(totalWeeks).fill('');
  const seenMonths  = new Set();
  const cells = [];
  const cur = new Date(startDate);

  for (let w = 0; w < totalWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      const isFuture = cur > today;
      if (!isFuture && cur.getDate() <= 7 && !seenMonths.has(cur.getMonth())) {
        seenMonths.add(cur.getMonth());
        monthLabels[w] = MONTHS[cur.getMonth()];
      }
      const locked = !isPro && cur < freeCutoff;
      const key = CLY.dateKey(cur);
      const val = isFuture ? null : (du[key] || 0);
      const bg  = isFuture ? 'transparent' : cellColor(val, locked);
      const tip = isFuture ? '' : locked ? 'Unlock Pro for full history' : `${key}: ${val ? val + ' msg' : 'no messages'}`;
      cells.push(`<div style="background:${bg};border-radius:1px;${locked ? 'opacity:0.25;' : ''}" title="${tip}"></div>`);
      cur.setDate(cur.getDate() + 1);
    }
  }

  const cols = `repeat(${totalWeeks},1fr)`;
  const monthRow =
    `<div style="display:grid;grid-template-columns:${cols};gap:1px;height:12px;margin-bottom:2px;">` +
    monthLabels.map(m => `<div style="font-size:8px;color:var(--text5);white-space:nowrap;overflow:visible;line-height:12px;">${m}</div>`).join('') +
    '</div>';

  const grid =
    `<div style="display:grid;grid-template-columns:${cols};grid-template-rows:repeat(7,1fr);grid-auto-flow:column;gap:1px;height:36px;">` +
    cells.join('') + '</div>';

  // Lock overlay for free users
  const lockOverlay = isPro ? '' : `
    <div style="margin-top:5px;font-size:10px;color:var(--text5);text-align:center;line-height:1.5;">
      Showing last ${FREE_DAYS} days · <span style="color:var(--accent);cursor:pointer;" id="unlock-link">Unlock full year →</span>
    </div>`;

  container.innerHTML = monthRow + grid + lockOverlay;

  if (!isPro) {
    const link = $('unlock-link');
    if (link) link.addEventListener('click', () => showView('settings'));
  }
}

// ── Monthly & weekly breakdown (Pro) ─────────────────────────────────────

function renderBreakdown(dailyUsage) {
  const container = $('breakdown-grid');
  const du = dailyUsage || {};
  const today = new Date(); today.setHours(0,0,0,0);

  // This week (Mon–today)
  const weekStart = new Date(today);
  const dow = today.getDay(); // 0=Sun
  weekStart.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));

  // Last week
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd   = new Date(weekStart); lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);

  // This month
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // Last month
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0);

  function sumRange(start, end) {
    let total = 0;
    const cur = new Date(start);
    while (cur <= end) {
      total += du[CLY.dateKey(cur)] || 0;
      cur.setDate(cur.getDate() + 1);
    }
    return total;
  }

  const thisWeek   = sumRange(weekStart, today);
  const lastWeek   = sumRange(lastWeekStart, lastWeekEnd);
  const thisMonth  = sumRange(monthStart, today);
  const lastMonth  = sumRange(lastMonthStart, lastMonthEnd);

  function deltaLabel(curr, prev) {
    if (!prev) return '';
    const diff = curr - prev;
    if (diff === 0) return '<span class="breakdown-delta">same as before</span>';
    const sign = diff > 0 ? '+' : '';
    const cls  = diff > 0 ? 'up' : 'down';
    return `<span class="breakdown-delta ${cls}">${sign}${diff} vs prior</span>`;
  }

  const cards = [
    { label: 'This Week',  val: thisWeek,  delta: deltaLabel(thisWeek, lastWeek) },
    { label: 'Last Week',  val: lastWeek,  delta: '' },
    { label: 'This Month', val: thisMonth, delta: deltaLabel(thisMonth, lastMonth) },
    { label: 'Last Month', val: lastMonth, delta: '' },
  ];

  container.innerHTML = cards.map(c => `
    <div class="breakdown-card">
      <div class="breakdown-val">${c.val}</div>
      <span class="breakdown-lbl">${c.label}</span>
      ${c.delta}
    </div>
  `).join('');
}

// ── Export ────────────────────────────────────────────────────────────────

function downloadFile(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('exportCsvBtn').addEventListener('click', () => {
  const dates = Object.keys(currentDailyUsage).sort();
  const csv = ['date,messages', ...dates.map(d => `${d},${currentDailyUsage[d]}`)].join('\n');
  downloadFile('clautics-export.csv', 'text/csv', csv);
});

$('exportJsonBtn').addEventListener('click', () => {
  const data = Object.keys(currentDailyUsage).sort()
    .map(date => ({ date, messages: currentDailyUsage[date] }));
  downloadFile('clautics-export.json', 'application/json', JSON.stringify(data, null, 2));
});

// ── State ─────────────────────────────────────────────────────────────────

function applyState(state) {
  if (!state) return;

  currentDailyUsage = state.dailyUsage || {};

  const tierBadge = $('tierBadge');
  tierBadge.textContent   = CLY.TIERS[state.tier] || '';
  tierBadge.style.display = tierBadge.textContent ? 'inline-block' : 'none';

  if (state.fetchedAt) {
    const ago = Math.round((Date.now() - state.fetchedAt) / 1000);
    $('fetchedAt').textContent = ago < 5 ? 'just now' : `${ago}s ago`;
  }

  CLY.renderPeak($('peak-banner'), state.heatmap, 'visible');
  renderLimits(state.limits);
  renderDailyStats(currentDailyUsage);
  render7DayChart(currentDailyUsage);

  if (isPro) {
    renderYearHeatmap(currentDailyUsage);
    renderBreakdown(currentDailyUsage);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────

loadProStatus().then(() => {
  chrome.runtime.sendMessage({ type: 'clautics_get' }, applyState);
});

// ── Theme ─────────────────────────────────────────────────────────────────

const THEME_KEY    = 'clautics_theme';
const THEME_COLORS = { dark: '#1a1a1a', light: '#f9f9f8' };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.backgroundColor = THEME_COLORS[theme];
  $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
}

chrome.storage.local.get(THEME_KEY, (r) => applyTheme(r[THEME_KEY] || 'dark'));

$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.local.set({ [THEME_KEY]: next });
  chrome.tabs.query({ url: '*://claude.ai/*' }, (tabs) => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'clautics_theme', theme: next }).catch(() => {});
  });
});

// ── Refresh ───────────────────────────────────────────────────────────────

$('refreshBtn').addEventListener('click', () => {
  $('refreshBtn').style.opacity = '0.4';
  chrome.runtime.sendMessage({ type: 'clautics_poll' }, (state) => {
    applyState(state);
    $('refreshBtn').style.opacity = '1';
  });
});

// Tick countdowns every 20s
CLY.interval(() => {
  for (const el of document.querySelectorAll('.lrow-reset[data-ts]')) {
    el.textContent = `↺ ${CLY.countdown(Number(el.dataset.ts))}`;
  }
}, 20_000);
