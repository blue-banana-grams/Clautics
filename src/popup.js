// Clautics — src/popup.js
'use strict';

const LABEL = {
  session:      '5-hr session',
  weekly:       'Weekly',
  sonnetWeekly: 'Sonnet weekly',
  opusWeekly:   'Opus weekly',
  extraUsage:   'Extra usage',
};
const KEY_ORDER   = ['session', 'weekly', 'sonnetWeekly', 'opusWeekly', 'extraUsage'];
const TIER_NAMES  = { free: 'Free', pro: 'Pro', team: 'Team', max_5x: 'Max 5×', max_20x: 'Max 20×' };
const DAYS_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FREE_DAYS   = 7;
const CLR_ACCENT  = '#cc785c';
const CLR_WARN    = '#e5534b';
const CLR_CAUTION = '#d4974a';

// ── Helpers ───────────────────────────────────────────────────────────────

function pctColor(pct) {
  if (pct >= 95) return CLR_WARN;
  if (pct >= 80) return CLR_CAUTION;
  return CLR_ACCENT;
}

function fmtCountdown(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h === 0)  return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function todayKey() { return fmtDateKey(new Date()); }

// ── Pro state ─────────────────────────────────────────────────────────────

let isPro = false;
let currentDailyUsage = {};
let currentHeatmap = [];

async function loadProStatus() {
  const { isPro: stored } = await chrome.storage.local.get('isPro');
  isPro = !!stored;
  applyProUI();
}

function applyProUI() {
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? (el.tagName === 'DIV' ? 'block' : 'inline-block') : 'none';
  };
  document.getElementById('proBadge').style.display       = isPro ? 'inline-block' : 'none';
  document.getElementById('upgrade-banner').classList.toggle('show', !isPro);
  show('buy-section', !isPro);
  show('custom-alerts-section', isPro);
  show('breakdown-section', isPro);
  show('export-section', isPro);
  // Year heatmap only visible to Pro users
  const yearSection = document.getElementById('year-section');
  if (yearSection) yearSection.style.display = isPro ? 'block' : 'none';
  document.getElementById('license-activate-section').style.display  = isPro ? 'none' : 'block';
  document.getElementById('license-deactivate-section').style.display = isPro ? 'block' : 'none';
  document.getElementById('pro-status-icon').textContent  = isPro ? '✅' : '🔓';
  document.getElementById('pro-status-label').textContent = isPro ? 'Pro — unlocked' : 'Free plan';
  document.getElementById('pro-status-sub').textContent   = isPro
    ? 'Full year history · export · all features'
    : '7-day history · basic stats';
  // Re-render heatmap with correct gating
  if (currentDailyUsage) renderYearHeatmap(currentDailyUsage);
  if (isPro) {
    renderBreakdown(currentDailyUsage);
    document.getElementById('breakdown-section').style.display = 'block';
    document.getElementById('export-section').style.display    = 'block';
    document.getElementById('custom-alerts-section').style.display = 'block';
  }
}

// ── View switching ────────────────────────────────────────────────────────

let currentView = 'main';

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.getElementById('refreshBtn').style.display = name === 'main' ? 'flex' : 'none';
  document.getElementById('settingsBtn').textContent  = name === 'settings' ? '←' : '⚙';
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  showView(currentView === 'settings' ? 'main' : 'settings');
});
document.getElementById('upgrade-banner').addEventListener('click', () => showView('settings'));

// ── License ───────────────────────────────────────────────────────────────

const licenseInput = document.getElementById('licenseInput');
const activateBtn  = document.getElementById('activateBtn');
const licenseMsg   = document.getElementById('licenseMsg');

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
  chrome.runtime.sendMessage({ type: 'clautics_activate', key }, ({ valid }) => {
    activateBtn.disabled    = false;
    activateBtn.textContent = 'Activate';
    if (valid) {
      isPro = true;
      licenseInput.className = 'license-input valid';
      showLicenseMsg('✓ Pro unlocked! All features are now active.', 'success');
      applyProUI();
    } else {
      licenseInput.className = 'license-input error';
      showLicenseMsg('Invalid key — check your email from Lemon Squeezy.', 'fail');
    }
  });
});

licenseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') activateBtn.click(); });

document.getElementById('deactivateBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ licenseKey: null, licenseInstanceId: null, isPro: false, licenseCheckedAt: null });
  isPro = false;
  licenseInput.value = '';
  licenseInput.className = 'license-input';
  licenseMsg.className   = 'license-msg';
  applyProUI();
});

// ── Custom alert thresholds ───────────────────────────────────────────────

const saveThresholdsBtn = document.getElementById('saveThresholdsBtn');

// Load saved values
chrome.storage.local.get(['alertWarnPct', 'alertCritPct'], (r) => {
  if (r.alertWarnPct) document.getElementById('threshWarn').value = r.alertWarnPct;
  if (r.alertCritPct) document.getElementById('threshCrit').value = r.alertCritPct;
});

saveThresholdsBtn.addEventListener('click', () => {
  const warn = Math.min(99,  Math.max(1, parseInt(document.getElementById('threshWarn').value) || 80));
  const crit = Math.min(100, Math.max(1, parseInt(document.getElementById('threshCrit').value) || 95));
  chrome.storage.local.set({ alertWarnPct: warn, alertCritPct: crit, alertsSent: {} }, () => {
    saveThresholdsBtn.textContent = '✓ Saved';
    saveThresholdsBtn.classList.add('saved');
    setTimeout(() => {
      saveThresholdsBtn.textContent = 'Save thresholds';
      saveThresholdsBtn.classList.remove('saved');
    }, 2000);
  });
});

// ── Peak banner ───────────────────────────────────────────────────────────

function getPeakInfo(heatmap) {
  const now = new Date();
  const hour = now.getHours(), day = now.getDay();
  const isWeekday  = day >= 1 && day <= 5;
  const isBizHours = hour >= 9 && hour < 18;
  const epochHour  = Math.floor(Date.now() / 3_600_000);
  const history    = (heatmap || []).filter(h => h.hour < epochHour && h.hour >= epochHour - 24);
  const avg        = history.length ? history.reduce((s, h) => s + h.delta, 0) / history.length : 0;
  const nowDelta   = (heatmap || []).find(h => h.hour === epochHour)?.delta ?? 0;
  const isYourPeak = avg > 0 && nowDelta > avg * 1.4;
  if (isWeekday && isBizHours && isYourPeak) return { show: true, text: 'Peak hours — Claude may be slower', icon: '🔴' };
  if (isWeekday && isBizHours)               return { show: true, text: 'Typical peak hours for Claude',    icon: '⚠️' };
  if (isYourPeak)                            return { show: true, text: 'Above your usual usage rate',       icon: '📈' };
  return { show: false };
}

function renderPeakBanner(heatmap) {
  const banner = document.getElementById('peak-banner');
  const info   = getPeakInfo(heatmap);
  if (info.show) {
    document.getElementById('peak-text').textContent = info.text;
    document.getElementById('peak-icon').textContent = info.icon;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

// ── Limits ────────────────────────────────────────────────────────────────

function renderLimits(limits) {
  const container = document.getElementById('limits');
  if (!limits) { container.innerHTML = '<div class="empty">No data yet.<br>Open claude.ai first.</div>'; return; }

  const entries = Object.entries(limits)
    .filter(([, v]) => v !== null)
    .sort(([a], [b]) => {
      const ai = KEY_ORDER.indexOf(a), bi = KEY_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  if (!entries.length) { container.innerHTML = '<div class="empty">No active limits found.</div>'; return; }

  container.innerHTML = '';
  for (const [key, limit] of entries) {
    const pct = limit.pct ?? 0, color = pctColor(pct);
    const row   = document.createElement('div'); row.className = 'lrow';
    const top   = document.createElement('div'); top.className = 'lrow-top';
    const label = document.createElement('span'); label.className = 'lrow-label'; label.textContent = LABEL[key] || key;
    const right = document.createElement('div'); right.className = 'lrow-right';
    const pctEl = document.createElement('span'); pctEl.className = 'lrow-pct'; pctEl.style.color = color; pctEl.textContent = `${pct.toFixed(0)}%`;
    const resetEl = document.createElement('span'); resetEl.className = 'lrow-reset';
    if (key === 'extraUsage' && limit.usedCents != null) {
      resetEl.textContent = `$${(limit.usedCents/100).toFixed(2)} / $${(limit.limitCents/100).toFixed(2)}`;
    } else if (limit.resetsAt) {
      resetEl.dataset.ts  = limit.resetsAt;
      resetEl.textContent = `↺ ${fmtCountdown(limit.resetsAt)}`;
    }
    right.appendChild(pctEl); right.appendChild(resetEl);
    top.appendChild(label); top.appendChild(right);
    const track = document.createElement('div'); track.className = 'track';
    const fill  = document.createElement('div'); fill.className = 'fill';
    fill.style.width = `${Math.min(pct, 100)}%`; fill.style.background = color;
    track.appendChild(fill);
    row.appendChild(top); row.appendChild(track);
    container.appendChild(row);
  }
}

// ── Daily stats pills ─────────────────────────────────────────────────────

function renderDailyStats(dailyUsage) {
  const du = dailyUsage || {};
  const today = new Date(); today.setHours(0,0,0,0);

  const todayVal = du[fmtDateKey(today)] || 0;

  // Streak: consecutive days ending today with >0 messages
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    if ((du[fmtDateKey(d)] || 0) > 0) streak++; else break;
  }

  // Avg: over last 30 days that have any data
  const vals = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const v = du[fmtDateKey(d)] || 0;
    if (v > 0) vals.push(v);
  }
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  document.getElementById('stat-today').textContent  = todayVal > 0 ? todayVal : '—';
  document.getElementById('stat-streak').innerHTML   = streak > 0 ? `${streak}<span class="fire"> 🔥</span>` : '—';
  document.getElementById('stat-avg').textContent    = avg > 0 ? avg.toFixed(1) : '—';
}

// ── 7-day bar chart ───────────────────────────────────────────────────────

function render7DayChart(dailyUsage) {
  const container = document.getElementById('seven-day-chart');
  const du = dailyUsage || {};
  const today = new Date(); today.setHours(0,0,0,0);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push({ date: d, key: fmtDateKey(d), isToday: i === 0 });
  }

  const vals   = days.map(d => du[d.key] || 0);
  const maxVal = Math.max(...vals, 1);

  container.innerHTML = '';
  days.forEach(({ date, isToday }, i) => {
    const val     = vals[i];
    const heightPct = Math.max((val / maxVal) * 100, val > 0 ? 6 : 3);
    const dayName   = DAYS_SHORT[date.getDay()];

    const col = document.createElement('div');
    col.className = 'chart-col';
    col.title = `${fmtDateKey(date)}: ${val > 0 ? val + ' msg' : 'no messages'}`;

    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';

    const bar = document.createElement('div');
    bar.className = isToday ? 'chart-bar today' : val > 0 ? 'chart-bar past-active' : 'chart-bar past';
    bar.style.height = `${heightPct}%`;

    const dayLbl = document.createElement('div');
    dayLbl.className   = 'chart-day-lbl';
    dayLbl.textContent = isToday ? 'Today' : dayName;

    const countLbl = document.createElement('div');
    countLbl.className   = `chart-count-lbl${val === 0 ? ' zero' : ''}`;
    countLbl.textContent = val > 0 ? String(val) : '—';

    wrap.appendChild(bar);
    col.appendChild(wrap);
    col.appendChild(dayLbl);
    col.appendChild(countLbl);
    container.appendChild(col);
  });
}

// ── Year heatmap ──────────────────────────────────────────────────────────

function renderYearHeatmap(dailyUsage) {
  const container = document.getElementById('daily-usage');
  const du = dailyUsage || {};

  const today = new Date(); today.setHours(0,0,0,0);
  const freeCutoff = new Date(today); freeCutoff.setDate(freeCutoff.getDate() - FREE_DAYS + 1);

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  startDate.setDate(startDate.getDate() - startDate.getDay()); // align to Sunday

  const totalDays  = Math.floor((today - startDate) / 86_400_000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  const allVals = Object.values(du).filter(Number.isFinite);
  const maxVal  = Math.max(...allVals, 0.001);

  function cellColor(val, locked) {
    if (locked || !val || val <= 0) return 'var(--bg3)';
    const r = Math.min(val / maxVal, 1);
    if (r < 0.2)  return 'rgba(204,120,92,0.2)';
    if (r < 0.4)  return 'rgba(204,120,92,0.4)';
    if (r < 0.65) return 'rgba(204,120,92,0.65)';
    if (r < 0.85) return 'rgba(204,120,92,0.85)';
    return '#cc785c';
  }

  // Month labels
  const monthCols = new Map();
  for (let w = 0; w < totalWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate); date.setDate(date.getDate() + w*7 + d);
      if (date > today) break;
      const m = date.getMonth();
      if (date.getDate() <= 7 && !monthCols.has(m)) monthCols.set(m, w);
    }
  }

  let monthRow = `<div style="display:grid;grid-template-columns:repeat(${totalWeeks},1fr);gap:1px;height:12px;margin-bottom:2px;">`;
  for (let w = 0; w < totalWeeks; w++) {
    const entry = [...monthCols.entries()].find(([, col]) => col === w);
    monthRow += `<div style="font-size:8px;color:var(--text5);white-space:nowrap;overflow:visible;line-height:12px;">${entry ? MONTHS[entry[0]] : ''}</div>`;
  }
  monthRow += '</div>';

  let grid = `<div style="display:grid;grid-template-columns:repeat(${totalWeeks},1fr);grid-template-rows:repeat(7,1fr);grid-auto-flow:column;gap:1px;height:36px;">`;
  for (let w = 0; w < totalWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date   = new Date(startDate); date.setDate(date.getDate() + w*7 + d);
      const isFuture = date > today;
      const locked   = !isPro && date < freeCutoff;
      const key  = fmtDateKey(date);
      const val  = isFuture ? null : (du[key] || 0);
      const bg   = isFuture ? 'transparent' : cellColor(val, locked);
      const tip  = isFuture ? '' : locked ? 'Unlock Pro for full history' : `${key}: ${val ? val + ' msg' : 'no messages'}`;
      grid += `<div style="background:${bg};border-radius:1px;${locked ? 'opacity:0.25;' : ''}" title="${tip}"></div>`;
    }
  }
  grid += '</div>';

  // Lock overlay for free users
  const lockOverlay = !isPro ? `
    <div style="margin-top:5px;font-size:10px;color:var(--text5);text-align:center;line-height:1.5;">
      Showing last ${FREE_DAYS} days · <span style="color:var(--accent);cursor:pointer;" id="unlock-link">Unlock full year →</span>
    </div>` : '';

  container.innerHTML = monthRow + grid + lockOverlay;

  if (!isPro) {
    const link = document.getElementById('unlock-link');
    if (link) link.addEventListener('click', () => showView('settings'));
  }
}

// ── Monthly & weekly breakdown (Pro) ─────────────────────────────────────

function renderBreakdown(dailyUsage) {
  const container = document.getElementById('breakdown-grid');
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
      total += du[fmtDateKey(cur)] || 0;
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

function exportCSV(dailyUsage) {
  const du = dailyUsage || {};
  const rows = [['date', 'messages']];
  const keys = Object.keys(du).sort();
  for (const key of keys) rows.push([key, du[key]]);
  const csv = rows.map(r => r.join(',')).join('\n');
  downloadFile('clautics-export.csv', 'text/csv', csv);
}

function exportJSON(dailyUsage) {
  const du = dailyUsage || {};
  const data = Object.keys(du).sort().map(date => ({ date, messages: du[date] }));
  downloadFile('clautics-export.json', 'application/json', JSON.stringify(data, null, 2));
}

function downloadFile(filename, type, content) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('exportCsvBtn').addEventListener('click', () => exportCSV(currentDailyUsage));
document.getElementById('exportJsonBtn').addEventListener('click', () => exportJSON(currentDailyUsage));

// ── State ─────────────────────────────────────────────────────────────────

function applyState(state) {
  if (!state) return;

  currentDailyUsage = state.dailyUsage || {};
  currentHeatmap    = state.heatmap    || [];

  const tierBadge = document.getElementById('tierBadge');
  const name = TIER_NAMES[state.tier];
  if (name) { tierBadge.textContent = name; tierBadge.style.display = 'inline-block'; }
  else tierBadge.style.display = 'none';

  if (state.fetchedAt) {
    const ago = Math.round((Date.now() - state.fetchedAt) / 1000);
    document.getElementById('fetchedAt').textContent = ago < 5 ? 'just now' : `${ago}s ago`;
  }

  renderPeakBanner(state.heatmap);
  renderLimits(state.limits);
  renderDailyStats(state.dailyUsage);
  render7DayChart(state.dailyUsage);

  if (isPro) {
    document.getElementById('year-section').style.display = 'block';
    renderYearHeatmap(state.dailyUsage);
    renderBreakdown(state.dailyUsage);
    document.getElementById('breakdown-section').style.display = 'block';
    document.getElementById('export-section').style.display    = 'block';
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
  document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
}

chrome.storage.local.get(THEME_KEY, (r) => applyTheme(r[THEME_KEY] || 'dark'));

document.getElementById('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.local.set({ [THEME_KEY]: next });
  chrome.tabs.query({ url: '*://claude.ai/*' }, (tabs) => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'clautics_theme', theme: next }).catch(() => {});
  });
});

// ── Refresh ───────────────────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', () => {
  document.getElementById('refreshBtn').style.opacity = '0.4';
  chrome.runtime.sendMessage({ type: 'clautics_poll' }, (state) => {
    applyState(state);
    document.getElementById('refreshBtn').style.opacity = '1';
  });
});

// Tick countdowns every 20s
setInterval(() => {
  document.querySelectorAll('.lrow-reset[data-ts]').forEach(el => {
    el.textContent = `↺ ${fmtCountdown(parseInt(el.dataset.ts))}`;
  });
}, 20_000);
