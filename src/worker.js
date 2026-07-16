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

// ── License validation ─────────────────────────────────────────────────────
// Lemon Squeezy requires two separate calls:
//   1. POST /activate  — first time; returns an instance_id we must store
//   2. POST /validate  — periodic re-checks using that instance_id
//
// Both endpoints live at https://api.lemonsqueezy.com/v1/licenses/...
// and need no API key — the license key itself is the credential.

const LS_ACTIVATE = 'https://api.lemonsqueezy.com/v1/licenses/activate';
const LS_VALIDATE = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LICENSE_CACHE_MS = 24 * 60 * 60 * 1000;

// ── Attempt limiting ─────────────────────────────────────────────────────
// activateLicense() is the closest thing this extension has to an auth
// route — cap it the same way a login endpoint would be: 5 attempts per
// rolling 15-minute window. Once exceeded, refuse locally (no network call)
// until the window clears.

const MAX_LICENSE_ATTEMPTS = 5;
const LICENSE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

async function checkLicenseAttemptLimit() {
  const { licenseAttempts } = await chrome.storage.local.get('licenseAttempts');
  const now = Date.now();
  const attempts = (licenseAttempts || []).filter((t) => now - t < LICENSE_ATTEMPT_WINDOW_MS);
  if (attempts.length >= MAX_LICENSE_ATTEMPTS) {
    const retryAfterMs = LICENSE_ATTEMPT_WINDOW_MS - (now - attempts[0]);
    return { blocked: true, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  return { blocked: false, attempts };
}

// Called when the user clicks "Activate" in the popup.
// Hits /activate, stores instance_id, marks isPro. Returns a plain boolean —
// the human-readable failure reason (invalid format, rate-limited, Lemon
// Squeezy rejection, network error) goes in `licenseError`.
async function activateLicense(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) {
    await chrome.storage.local.set({ isPro: false, licenseError: 'Invalid license key format' });
    return false;
  }

  const { blocked, retryAfterMs, attempts } = await checkLicenseAttemptLimit();
  if (blocked) {
    const minutes = Math.ceil(retryAfterMs / 60_000);
    await chrome.storage.local.set({ isPro: false, licenseError: `Too many attempts — try again in ${minutes} min` });
    return false;
  }

  try {
    const res = await fetch(LS_ACTIVATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: 'Clautics Chrome Extension' }),
    });
    const data = await res.json();

    // Lemon Squeezy returns { activated: true, instance: { id: "..." }, license_key: { status: "active" } }
    const activated  = data?.activated === true;
    const instanceId = data?.instance?.id || null;
    const status     = data?.license_key?.status;

    // "active" or "inactive" keys are valid; "disabled" / "expired" are not
    const valid = activated && (status === 'active' || status === 'inactive');

    if (valid) await chrome.storage.local.set({ licenseAttempts: [] });
    else await chrome.storage.local.set({ licenseAttempts: [...attempts, Date.now()] });

    await chrome.storage.local.set({
      licenseKey:       key,
      licenseInstanceId: instanceId,
      isPro:            valid,
      licenseCheckedAt: Date.now(),
      licenseError:     valid ? null : (data?.error || 'Activation failed'),
    });
    return valid;
  } catch (err) {
    // Network failure — don't mark as invalid, just leave existing state
    console.warn('Clautics: license activation network error', err);
    return false;
  }
}

// Called on startup / alarm to periodically re-confirm the key is still valid.
// Uses /validate + instance_id. Falls back to /activate if instance_id is missing.
async function validateLicense() {
  const { licenseKey, licenseInstanceId, isPro, licenseCheckedAt } =
    await chrome.storage.local.get(['licenseKey', 'licenseInstanceId', 'isPro', 'licenseCheckedAt']);

  if (!licenseKey) {
    await chrome.storage.local.set({ isPro: false });
    return false;
  }

  // Use cached result within 24 hours
  if (licenseCheckedAt && Date.now() - licenseCheckedAt < LICENSE_CACHE_MS) {
    return !!isPro;
  }

  // No instance_id yet — re-run activation to get one
  if (!licenseInstanceId) {
    return activateLicense(licenseKey);
  }

  try {
    const res = await fetch(LS_VALIDATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, instance_id: licenseInstanceId }),
    });
    const data = await res.json();
    const valid = data?.valid === true;
    await chrome.storage.local.set({ isPro: valid, licenseCheckedAt: Date.now() });
    return valid;
  } catch {
    // Network failure — trust cached value, don't revoke Pro
    return !!isPro;
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

// ── Smart alerts ──────────────────────────────────────────────────────────
// Only fires for Pro users. Uses custom thresholds saved by the popup's
// settings page, falling back to 80 % (warning) and 95 % (critical).

async function checkAlerts(limits, alertsSent) {
  // Gate on Pro
  const { isPro } = await chrome.storage.local.get('isPro');
  if (!isPro) return alertsSent || {};

  if (!limits) return alertsSent || {};

  const { alertWarnPct, alertCritPct } = await chrome.storage.local.get(['alertWarnPct', 'alertCritPct']);
  const warnPct = Number(alertWarnPct) || 80;
  const critPct = Number(alertCritPct) || 95;
  const thresholds = [
    { pct: warnPct, label: 'Warning' },
    { pct: critPct, label: 'Critical' },
  ];

  const updated = { ...(alertsSent || {}) };

  const tracked = [
    { key: 'session',      val: limits.session?.pct,      name: '5-hr session' },
    { key: 'weekly',       val: limits.weekly?.pct,       name: 'Weekly' },
    { key: 'sonnetWeekly', val: limits.sonnetWeekly?.pct, name: 'Sonnet weekly' },
    { key: 'opusWeekly',   val: limits.opusWeekly?.pct,   name: 'Opus weekly' },
  ];

  for (const { key, val, name } of tracked) {
    if (val == null) continue;
    for (const { pct: threshold, label: severity } of thresholds) {
      // Use fixed 'warn'/'crit' keys so they survive threshold value changes
      const alertKey = `${key}_${severity}`;
      if (!updated[alertKey] && val >= threshold) {
        try {
          await chrome.notifications.create(`clt_${key}_${severity}_${Date.now()}`, {
            type:     'basic',
            title:    `Clautics — ${name} at ${threshold}%`,
            message:  `${severity}: You've used ${val.toFixed(0)}% of your ${name} limit.`,
            iconUrl:  chrome.runtime.getURL('icons/icon48.png'),
          });
        } catch (err) {
          console.warn('Clautics: notification failed', err);
        }
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

  // Reset per-limit alert flags when a limit resets (big drop in pct)
  // Keys use 'warn'/'crit' labels (not numeric values) so they're stable
  const alertsSentUpdated = { ...(state.alertsSent || {}) };
  for (const key of ['session', 'weekly', 'sonnetWeekly', 'opusWeekly']) {
    const prev = state.lastPercent?.[key] ?? 0;
    const curr = limits[key]?.pct ?? 0;
    if (prev > 50 && curr < 10) {
      delete alertsSentUpdated[`${key}_Warning`];
      delete alertsSentUpdated[`${key}_Critical`];
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
    alertsSent: await checkAlerts(limits, alertsSentUpdated),
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

    // Call poll directly — setTimeout is unreliable in MV3 service workers
    if (isCompletion || pathname.includes('/usage')) {
      poll().catch(console.warn);
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
    activateLicense(msg.key).then(async (valid) => {
      const { licenseError } = await chrome.storage.local.get('licenseError');
      reply({ valid, error: valid ? null : licenseError });
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
