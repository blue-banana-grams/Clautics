// Clautics — src/worker.js
'use strict';

const HEATMAP_HOURS = 24 * 7;
const STORAGE_KEY   = 'clautics_v1';

// ── Storage ────────────────────────────────────────────────────────────────

async function load() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] || defaultState();
}

async function save(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function defaultState() {
  return {
    limits:      null,
    tier:        'unknown',
    orgId:       null,
    heatmap:     [],
    dailyUsage:  {},
    lastPercent: {},
    alertsSent:  {},
    fetchedAt:   null,
  };
}

// ── License validation ─────────────────────────────────────────────────────

const LICENSE_CACHE_MS = 24 * 60 * 60 * 1000;

async function validateLicense() {
  const { licenseKey, isPro, licenseCheckedAt } = await chrome.storage.local.get(
    ['licenseKey', 'isPro', 'licenseCheckedAt']
  );
  if (!licenseKey) {
    await chrome.storage.local.set({ isPro: false });
    return false;
  }
  if (licenseCheckedAt && Date.now() - licenseCheckedAt < LICENSE_CACHE_MS) {
    return !!isPro;
  }
  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    const data = await res.json();
    const valid = data?.activated === true || data?.valid === true;
    await chrome.storage.local.set({ isPro: valid, licenseCheckedAt: Date.now() });
    return valid;
  } catch {
    if (licenseCheckedAt) return !!isPro;
    return false;
  }
}

// ── Org ID ─────────────────────────────────────────────────────────────────

async function getOrgId() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
    if (!tabs.length) return null;
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    return cookie?.value || null;
  } catch { return null; }
}

// ── Fetch Claude API ───────────────────────────────────────────────────────

async function fetchUsage(orgId) {
  if (!orgId) return null;
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: 'include', headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function fetchTier(orgId) {
  if (!orgId) return 'unknown';
  try {
    const res = await fetch(
      `https://claude.ai/api/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`,
      { credentials: 'include', headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return 'unknown';
    const data = await res.json();
    const memberships = data?.account?.memberships || [];
    const org  = memberships.find(m => m.organization?.uuid === orgId)?.organization;
    if (!org) return 'unknown';
    const caps   = org.capabilities || [];
    const raven  = !!org.raven_type;
    const rlTier = org.rate_limit_tier || '';
    if (raven)                       return 'team';
    if (caps.includes('claude_max')) return rlTier.includes('5x') ? 'max_5x' : 'max_20x';
    if (caps.includes('claude_pro')) return 'pro';
    return 'free';
  } catch { return 'unknown'; }
}

// ── Parse limits ───────────────────────────────────────────────────────────

function parseLimits(raw) {
  const parseOne = (obj) => {
    if (!obj) return null;
    return { pct: obj.utilization ?? 0, resetsAt: new Date(obj.resets_at).getTime() };
  };
  const extra = raw.extra_usage?.is_enabled ? {
    pct:        raw.extra_usage.used_credits / raw.extra_usage.monthly_limit * 100,
    usedCents:  raw.extra_usage.used_credits,
    limitCents: raw.extra_usage.monthly_limit,
    resetsAt:   null,
  } : null;
  return {
    session:      parseOne(raw.five_hour),
    weekly:       parseOne(raw.seven_day),
    sonnetWeekly: parseOne(raw.seven_day_sonnet),
    opusWeekly:   parseOne(raw.seven_day_opus),
    extraUsage:   extra,
  };
}

// ── Heatmap ────────────────────────────────────────────────────────────────

function currentEpochHour() {
  return Math.floor(Date.now() / 3_600_000);
}

function updateHeatmap(heatmap, delta) {
  if (delta <= 0) return heatmap;
  const hour     = currentEpochHour();
  const copy     = [...heatmap];
  const existing = copy.find(h => h.hour === hour);
  if (existing) existing.delta += delta;
  else copy.push({ hour, delta });
  const cutoff = hour - HEATMAP_HOURS;
  return copy.filter(h => h.hour >= cutoff);
}

// ── Daily usage ────────────────────────────────────────────────────────────

function dailyKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function pruneDailyUsage(du) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;
  const copy = { ...du };
  for (const k of Object.keys(copy)) { if (k < cutoffKey) delete copy[k]; }
  return copy;
}

// ── Smart alerts (custom thresholds) ──────────────────────────────────────

async function checkAlerts(state) {
  const { limits, alertsSent } = state;
  if (!limits) return alertsSent;

  // Read thresholds — fall back to 80/95 defaults
  const { alertWarnPct, alertCritPct } = await chrome.storage.local.get(['alertWarnPct', 'alertCritPct']);
  const thresholds = [alertWarnPct || 80, alertCritPct || 95];

  const updated = { ...alertsSent };
  const trackedKeys = [
    { key: 'session',      pct: limits.session?.pct,      label: '5-hr session' },
    { key: 'weekly',       pct: limits.weekly?.pct,       label: 'Weekly' },
    { key: 'sonnetWeekly', pct: limits.sonnetWeekly?.pct, label: 'Sonnet weekly' },
    { key: 'opusWeekly',   pct: limits.opusWeekly?.pct,   label: 'Opus weekly' },
  ];

  for (const { key, pct, label } of trackedKeys) {
    if (pct == null) continue;
    for (const threshold of thresholds) {
      const alertKey = `${key}_${threshold}`;
      if (!updated[alertKey] && pct >= threshold) {
        chrome.notifications.create(`clt_${Date.now()}`, {
          type: 'basic',
          title: `Clautics: ${label} at ${threshold}%`,
          message: `You've used ${pct.toFixed(0)}% of your ${label} limit.`,
          iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        });
        updated[alertKey] = true;
      }
    }
  }
  return updated;
}

// ── Main poll cycle ────────────────────────────────────────────────────────

async function poll() {
  const state = await load();

  let orgId = state.orgId || await getOrgId();
  if (!orgId) return;

  const raw = await fetchUsage(orgId);
  if (!raw) return;

  let tier = state.tier;
  if (tier === 'unknown') tier = await fetchTier(orgId);

  const limits = parseLimits(raw);

  const lastPercent = {};
  for (const key of ['session', 'weekly', 'sonnetWeekly', 'opusWeekly']) {
    lastPercent[key] = limits[key]?.pct ?? 0;
  }

  // Reset per-limit alert flags when a limit resets (big drop)
  const alertsSentUpdated = { ...state.alertsSent };
  const { alertWarnPct, alertCritPct } = await chrome.storage.local.get(['alertWarnPct', 'alertCritPct']);
  const activeThresholds = [alertWarnPct || 80, alertCritPct || 95];
  for (const key of ['session', 'weekly', 'sonnetWeekly', 'opusWeekly']) {
    const prev = state.lastPercent[key] ?? 0;
    const curr = limits[key]?.pct ?? 0;
    if (prev > 50 && curr < 10) {
      for (const t of activeThresholds) delete alertsSentUpdated[`${key}_${t}`];
    }
  }

  // Reload to avoid clobbering webRequest-written heatmap/dailyUsage
  const freshState = await load();

  const newState = {
    ...freshState,
    limits,
    tier,
    orgId,
    lastPercent,
    fetchedAt: Date.now(),
    alertsSent: await checkAlerts({ limits, alertsSent: alertsSentUpdated }),
  };

  await save(newState);

  const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'clautics_update', data: newState }).catch(() => {});
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pathname = new URL(details.url).pathname;
    const isCompletion = pathname.endsWith('/completion');

    if (isCompletion) {
      const state = await load();
      const key   = dailyKey();
      const daily = pruneDailyUsage({ ...(state.dailyUsage || {}) });
      daily[key]  = (daily[key] || 0) + 1;
      const heatmap = updateHeatmap(state.heatmap, 1);
      await save({ ...state, dailyUsage: daily, heatmap });
    }

    if (isCompletion || pathname.includes('/usage')) {
      setTimeout(poll, 150);
    }
  },
  { urls: ['*://claude.ai/api/organizations/*'] }
);

chrome.alarms.create('clautics_poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'clautics_poll') poll();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'clautics_get') {
    load().then(reply);
    return true;
  }
  if (msg.type === 'clautics_poll') {
    poll().then(() => load()).then(reply);
    return true;
  }
  if (msg.type === 'clautics_activate') {
    chrome.storage.local.set({ licenseKey: msg.key, licenseCheckedAt: null }, async () => {
      const valid = await validateLicense();
      reply({ valid });
    });
    return true;
  }
  if (msg.type === 'clautics_check_license') {
    validateLicense().then(valid => reply({ valid }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => { validateLicense(); poll(); });
chrome.runtime.onStartup.addListener(() => { validateLicense(); poll(); });
