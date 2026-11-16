// Clautics — src/worker.js
'use strict';

importScripts('/src/common.js', '/src/coach.js');

const HEATMAP_HOURS = 24 * 7;
const STORAGE_KEY   = 'clautics_v1';
const CONTENT_JS    = ['src/common.js', 'src/coach.js', 'src/page.js'];
const CONTENT_CSS   = ['src/panel.css'];

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
    // Coach inputs — see recordSamples() and attributeCosts().
    samples:     {},
    msgCosts:    [],
    convCost:    {},
    pending:     [],
    lastConv:    null,
  };
}

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
    await chrome.storage.local.set({ isPro: false, licenseError: chrome.i18n.getMessage('licenseErrInvalidFormat') });
    return false;
  }

  const { blocked, retryAfterMs, attempts } = await checkLicenseAttemptLimit();
  if (blocked) {
    const minutes = Math.ceil(retryAfterMs / 60_000);
    await chrome.storage.local.set({ isPro: false, licenseError: chrome.i18n.getMessage('licenseErrTooManyAttempts', [String(minutes)]) });
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
      licenseError:     valid ? null : (data?.error || chrome.i18n.getMessage('licenseErrActivationFailed')),
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

// ── Serialized state updates ───────────────────────────────────────────────
// The completion listener and the poll both read-modify-write the same state
// object. Running them through one queue means neither can overwrite what the
// other just wrote (the old code re-loaded mid-poll and hoped for the best).

let updateQueue = Promise.resolve();

function update(fn) {
  const run = updateQueue.then(async () => {
    const next = await fn(await load());
    if (next) await save(next);
    return next;
  });
  updateQueue = run.catch(() => {});
  return run;
}

// ── Talking to claude.ai ───────────────────────────────────────────────────
// The worker fetches claude.ai directly first. If that fails (a claude.ai
// tab's cookies/bot checks are the reliable path), it asks the content script
// in an open claude.ai tab to make the same request from the page's own
// origin, which always carries the user's session.

async function claudeTabs() {
  try { return await chrome.tabs.query({ url: '*://claude.ai/*' }); } catch { return []; }
}

async function fetchJson(path) {
  try {
    const res = await fetch(`https://claude.ai${path}`, {
      credentials: 'include', headers: { 'Accept': 'application/json' },
    });
    if (res.ok) return { ok: true, data: await res.json() };
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // Could be a stale org or a worker-side block — let a tab try too.
      const viaTab = await fetchViaTab(path);
      return viaTab || { ok: false, status: res.status };
    }
  } catch {}
  return (await fetchViaTab(path)) || { ok: false, status: 0 };
}

async function fetchViaTab(path) {
  for (const tab of await claudeTabs()) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'clautics_fetch', path });
      if (res?.ok) return res;
    } catch {}
  }
  return null;
}

// The org the user is currently in. Read from the cookie on every poll rather
// than cached forever — switching accounts or orgs used to leave the extension
// polling the old org (and failing) until it was reinstalled.
async function getOrgId(fallback) {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    if (cookie?.value) return cookie.value;
  } catch {}
  return fallback || null;
}

async function fetchTier(orgId) {
  const res = await fetchJson(`/api/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`);
  if (!res.ok) return null;
  const memberships = res.data?.account?.memberships || [];
  const org = memberships.find((m) => m.organization?.uuid === orgId)?.organization;
  if (!org) return null;
  const caps = org.capabilities || [];
  const rl   = String(org.rate_limit_tier || '').toLowerCase();
  if (org.raven_type) return 'team';
  // Max 20× was renamed Ultra (10× Pro weekly, no 5-hour limit once verified).
  if (caps.includes('claude_ultra') || rl.includes('ultra') || rl.includes('20x')) return 'ultra';
  if (caps.includes('claude_max')) return 'max_5x';
  if (caps.includes('claude_pro')) return 'pro';
  return 'free';
}

// ── Parse limits ───────────────────────────────────────────────────────────
// five_hour → session, seven_day → weekly, and every per-model weekly bucket
// (seven_day_opus, seven_day_sonnet, seven_day_fable, and whatever model gets
// its own bucket next) → <model>Weekly, so a new bucket shows up without a
// code change.

function parseLimits(raw) {
  const parseOne = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const pct = Number(obj.utilization);
    const resetsAt = obj.resets_at ? Date.parse(obj.resets_at) : NaN;
    return {
      pct: Number.isFinite(pct) ? pct : 0,
      // A session that hasn't started has no reset time; this used to become
      // new Date(null) = 1970 and show "resetting…" forever.
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    };
  };

  const limits = { session: parseOne(raw.five_hour), weekly: parseOne(raw.seven_day) };
  for (const [k, v] of Object.entries(raw || {})) {
    const m = /^seven_day_([a-z]+)$/.exec(k);   // skips e.g. seven_day_oauth_apps
    if (!m) continue;
    const p = parseOne(v);
    if (p) limits[`${m[1]}Weekly`] = p;
  }

  const ex = raw.extra_usage;
  if (ex?.is_enabled) {
    const used  = Number(ex.used_credits) || 0;
    const limit = Number(ex.monthly_limit);
    const capped = Number.isFinite(limit) && limit > 0;
    limits.extraUsage = {
      pct:        capped ? (used / limit) * 100 : 0,
      usedCents:  used,
      limitCents: capped ? limit : null,   // null = no monthly cap set
      resetsAt:   null,
    };
  }

  for (const k of Object.keys(limits)) if (!limits[k]) delete limits[k];
  return limits;
}

// ── Heatmap ────────────────────────────────────────────────────────────────

function currentEpochHour() {
  return Math.floor(Date.now() / 3_600_000);
}

function updateHeatmap(heatmap, delta) {
  if (delta <= 0) return heatmap;
  const hour     = currentEpochHour();
  const copy     = [...(heatmap || [])];
  const existing = copy.find(h => h.hour === hour);
  if (existing) existing.delta += delta;
  else copy.push({ hour, delta });
  const cutoff = hour - HEATMAP_HOURS;
  return copy.filter(h => h.hour >= cutoff);
}

// ── Daily usage ────────────────────────────────────────────────────────────

// Drops entries older than 400 days. Keys are ISO-ish yyyy-mm-dd, so a string
// compare against the cutoff key is the same as a date compare.
// Runs at most once a day rather than on every single completion.
let lastPruneKey = null;

function pruneDailyUsage(du, todayKey) {
  if (lastPruneKey === todayKey) return du;
  lastPruneKey = todayKey;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  const cutoffKey = CLY.dateKey(cutoff);
  const copy = { ...du };
  for (const k of Object.keys(copy)) { if (k < cutoffKey) delete copy[k]; }
  return copy;
}

// ── Usage history (feeds the coach) ────────────────────────────────────────
// samples[key] = [[time, pct, resetsAt], ...] — a reading whenever the
// percentage moves, plus a heartbeat every 10 minutes so "how fast over the
// last hour" always has a starting point. Eight days covers a full weekly
// window.

const SAMPLE_KEEP_MS    = 8 * 24 * 3_600_000;
const SAMPLE_HEARTBEAT  = 10 * 60_000;
const SAMPLE_MAX        = 1500;

function recordSamples(samples, limits, now) {
  const out = {};
  for (const [key, arr] of Object.entries(samples || {})) {
    out[key] = arr.filter((s) => now - s[0] <= SAMPLE_KEEP_MS);
  }
  for (const [key, lim] of Object.entries(limits)) {
    if (key === 'extraUsage' || !lim.resetsAt) continue;
    const arr = out[key] || (out[key] = []);
    const last = arr[arr.length - 1];
    if (!last || last[1] !== lim.pct || !COACH.sameWindow(last[2], lim.resetsAt) || now - last[0] >= SAMPLE_HEARTBEAT) {
      arr.push([now, lim.pct, lim.resetsAt]);
    }
    if (arr.length > SAMPLE_MAX) arr.splice(0, arr.length - SAMPLE_MAX);
  }
  return out;
}

// ── Cost per message ───────────────────────────────────────────────────────
// Every completion is queued in `pending`. When the next usage reading comes
// in, the change in the primary limit (the 5-hour session, or weekly when the
// plan has no session limit) is split evenly across the queued messages and
// credited to their conversations. That's how the coach knows ~how many
// messages are left and which chat has become expensive.
//
// Usage can lag the completion by a few seconds, so a message whose reading
// hasn't moved yet stays queued for up to 90s before being counted as ~0.

const PENDING_GRACE_MS = 90_000;
const MSG_COSTS_MAX    = 200;
const CONV_KEEP        = 50;

function attributeCosts(next, prev, now) {
  const pending = next.pending || [];
  if (!pending.length) return;
  const key = COACH.primaryKey(next.limits);
  const cur = key && next.limits[key];
  const before = prev.limits?.[key];

  // First reading ever, or nothing to measure against: drop the queue rather
  // than credit the whole existing percentage to the last message.
  if (!cur || !prev.limits) { next.pending = []; return; }

  let base;
  if (!before || !before.resetsAt || before.resetsAt <= now) base = 0;         // a new window started
  else if (COACH.sameWindow(before.resetsAt, cur.resetsAt)) base = before.pct;
  else { next.pending = []; return; }                                             // window jumped — unreliable

  const delta = cur.pct - base;
  if (delta < 0) { next.pending = []; return; }
  if (delta === 0 && pending.some((p) => now - p.t < PENDING_GRACE_MS)) return; // wait for the reading to catch up

  const per = delta / pending.length;
  const costs = [...(next.msgCosts || [])];
  const convs = { ...(next.convCost || {}) };
  for (const p of pending) {
    costs.push([p.t, per, p.conv]);
    const c = convs[p.conv] || { n: 0, pct: 0, measured: 0, last: p.t };
    convs[p.conv] = { ...c, pct: c.pct + per, measured: c.measured + 1 };
  }
  next.msgCosts = costs.slice(-MSG_COSTS_MAX);
  next.convCost = pruneConvs(convs);
  next.pending  = [];
}

function pruneConvs(convs) {
  const ids = Object.keys(convs);
  if (ids.length <= CONV_KEEP) return convs;
  ids.sort((a, b) => convs[b].last - convs[a].last);
  const out = {};
  for (const id of ids.slice(0, CONV_KEEP)) out[id] = convs[id];
  return out;
}

// ── Smart alerts ──────────────────────────────────────────────────────────
// Threshold alerts are Pro-only and use custom thresholds saved by the
// popup's settings page, falling back to 80 % (warning) and 95 % (critical).
// Pace alerts ("you'll run out in 40m") are free, on by default, and fire
// once per window.

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(`clt_${id}_${Date.now()}`, {
      type: 'basic', title, message, iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    });
  } catch (err) {
    console.warn('Clautics: notification failed', err);
  }
}

async function checkAlerts(state, alertsSent) {
  const { isPro, alertWarnPct, alertCritPct, paceAlerts } =
    await chrome.storage.local.get(['isPro', 'alertWarnPct', 'alertCritPct', 'paceAlerts']);
  const limits = state.limits;
  const updated = { ...(alertsSent || {}) };
  if (!limits) return updated;
  const now = Date.now();

  if (isPro) {
    const warnPct = Number(alertWarnPct) || 80;
    const critPct = Number(alertCritPct) || 95;
    // storageLabel is a stable, English, never-localized fragment of the
    // alertsSent storage key (and matches the hardcoded 'Warning'/'Critical'
    // in poll()'s reset logic below) — it must NOT change with the user's
    // language, or switching languages would silently duplicate or drop
    // already-sent alerts. `text` is the localized word actually shown.
    const thresholds = [
      { pct: warnPct, storageLabel: 'Warning',  text: chrome.i18n.getMessage('severityWarning') },
      { pct: critPct, storageLabel: 'Critical', text: chrome.i18n.getMessage('severityCritical') },
    ];
    for (const [key, lim] of Object.entries(limits)) {
      if (key === 'extraUsage') continue;
      const name = CLY.label(key);
      for (const { pct: threshold, storageLabel, text: severity } of thresholds) {
        const alertKey = `${key}_${storageLabel}`;
        if (!updated[alertKey] && lim.pct >= threshold) {
          await notify(`${key}_${storageLabel}`,
            chrome.i18n.getMessage('notifTitle', [name, String(threshold)]),
            chrome.i18n.getMessage('notifBody', [severity, lim.pct.toFixed(0), name]));
          updated[alertKey] = true;
        }
      }
    }
  }

  // Pace alerts. Keys carry the window's reset time and expire with it.
  for (const k of Object.keys(updated)) {
    if (k.startsWith('pace_') && typeof updated[k] === 'number' && updated[k] < now) delete updated[k];
  }
  if (paceAlerts !== false) {
    const analysis = COACH.analyze(state, now);
    for (const p of Object.values(analysis.pace)) {
      if (!COACH.paceAlertDue(p, now)) continue;
      const resetsAt = limits[p.key].resetsAt;
      const alertKey = `pace_${p.key}_${Math.round(resetsAt / 600_000)}`;
      if (updated[alertKey]) continue;
      await notify(alertKey,
        chrome.i18n.getMessage('paceNotifTitle', [CLY.label(p.key)]),
        chrome.i18n.getMessage('paceNotifBody', [CLY.duration(p.runOutAt - now), CLY.duration(resetsAt - p.runOutAt)]));
      updated[alertKey] = resetsAt;
    }
  }
  return updated;
}

// ── Main poll cycle ────────────────────────────────────────────────────────

const TIER_REFRESH_MS = 24 * 3_600_000;
const IDLE_POLL_MS    = 5 * 60_000;   // with no claude.ai tab open

async function poll({ force = false } = {}) {
  const prev = await load();
  const tabs = await claudeTabs();

  // With claude.ai closed, usage still moves (Claude Code and the desktop app
  // share the same limits), so keep tracking — just less often.
  if (!force && !tabs.length && prev.attemptAt && Date.now() - prev.attemptAt < IDLE_POLL_MS) return;
  await update((s) => ({ ...s, attemptAt: Date.now() }));

  const orgId = await getOrgId(prev.orgId);
  if (!orgId) return;

  const usage = await fetchJson(`/api/organizations/${orgId}/usage`);
  if (!usage.ok) return;

  const orgChanged = orgId !== prev.orgId;
  let tier = orgChanged ? 'unknown' : prev.tier;
  let tierCheckedAt = orgChanged ? null : prev.tierCheckedAt;
  if (tier === 'unknown' || !tierCheckedAt || Date.now() - tierCheckedAt > TIER_REFRESH_MS) {
    const fresh = await fetchTier(orgId);
    if (fresh) { tier = fresh; tierCheckedAt = Date.now(); }
  }

  const limits = parseLimits(usage.data);

  const state = await update((s) => {
    const now = Date.now();
    const next = { ...s, limits, tier, tierCheckedAt, orgId, fetchedAt: now };

    if (orgChanged && s.orgId) {
      // Another account's history would make the coach's numbers nonsense.
      Object.assign(next, { samples: {}, msgCosts: [], convCost: {}, pending: [], lastConv: null, alertsSent: {} });
      return next;
    }

    next.samples = recordSamples(s.samples, limits, now);
    attributeCosts(next, s, now);

    // Reset per-limit alert flags when a limit resets (big drop in pct).
    const alertsSent = { ...(s.alertsSent || {}) };
    for (const key of Object.keys(limits)) {
      const before = s.lastPercent?.[key] ?? 0;
      if (before > 50 && limits[key].pct < 10) {
        delete alertsSent[`${key}_Warning`];
        delete alertsSent[`${key}_Critical`];
      }
    }
    next.alertsSent = alertsSent;
    next.lastPercent = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.pct]));
    return next;
  });

  const alertsSent = await checkAlerts(state, state.alertsSent);
  const final = await update((s) => ({ ...s, alertsSent }));

  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'clautics_update', data: final }).catch(() => {});
  }
  syncToDesktop(final).catch(() => {});
  return final;
}

// ── Clautics Desktop sync ──────────────────────────────────────────────────
// The desktop menu-bar app can't see messages being sent (that happens here,
// in the browser), so after each poll the extension hands it the message
// counts and per-message costs it measured. The desktop app listens on
// localhost only and accepts this extension's origin only. If it isn't
// installed or running, the request is refused instantly; we then stay quiet
// for a few minutes instead of retrying every poll.

const DESKTOP_SYNC_URL   = 'http://127.0.0.1:47285/sync';
const DESKTOP_RETRY_MS   = 5 * 60_000;

async function syncToDesktop(state) {
  if (!state) return;
  try {
    const { desktopSyncDownAt } = await chrome.storage.session.get('desktopSyncDownAt');
    if (desktopSyncDownAt && Date.now() - desktopSyncDownAt < DESKTOP_RETRY_MS) return;
    const res = await fetch(DESKTOP_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId:      state.orgId || null,
        dailyUsage: state.dailyUsage || {},
        heatmap:    state.heatmap || [],
        msgCosts:   state.msgCosts || [],
        convCost:   state.convCost || {},
        lastConv:   state.lastConv || null,
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`desktop sync ${res.status}`);
    if (desktopSyncDownAt) await chrome.storage.session.remove('desktopSyncDownAt');
  } catch {
    await chrome.storage.session.set({ desktopSyncDownAt: Date.now() }).catch(() => {});
  }
}

// One poll at a time; extra requests while one is running share its result.
let polling = null;
let pollTimer = null;
let lastPollAt = 0;

function runPoll(opts) {
  if (!polling) {
    lastPollAt = Date.now();
    polling = poll(opts).catch((err) => console.warn('Clautics: poll failed', err)).finally(() => { polling = null; });
  }
  return polling;
}

// setTimeout is unreliable for long delays in an MV3 service worker, but a
// few seconds right after the event that woke it up is fine.
function schedulePoll(delayMs) {
  if (pollTimer) return;
  pollTimer = setTimeout(() => { pollTimer = null; runPoll(); }, delayMs);
}

// ── Listeners ──────────────────────────────────────────────────────────────

const COMPLETION_RE = /\/chat_conversations\/([^/]+)\/(?:retry_)?completion$/;
const PENDING_MAX   = 50;

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Our own requests (from the worker, or the content-script fallback that
    // fetches /usage) must not trigger another poll — that's a feedback loop.
    if (details.tabId < 0 || details.initiator?.startsWith('chrome-extension://')) return;

    const pathname = new URL(details.url).pathname;
    const m = COMPLETION_RE.exec(pathname);

    if (m && details.statusCode < 400) {
      const conv = m[1];
      const now = Date.now();
      update((s) => {
        const key   = CLY.dateKey(new Date(now));
        const daily = pruneDailyUsage({ ...(s.dailyUsage || {}) }, key);
        daily[key]  = (daily[key] || 0) + 1;
        const convs = { ...(s.convCost || {}) };
        const c = convs[conv] || { n: 0, pct: 0, measured: 0, last: now };
        convs[conv] = { ...c, n: c.n + 1, last: now };
        return {
          ...s,
          dailyUsage: daily,
          heatmap: updateHeatmap(s.heatmap, 1),
          pending: [...(s.pending || []), { t: now, conv }].slice(-PENDING_MAX),
          convCost: pruneConvs(convs),
          lastConv: { id: conv, t: now },
        };
      }).catch(console.warn);
      // Give claude.ai a moment to update its usage numbers, then read them.
      schedulePoll(3000);
      return;
    }

    // claude.ai itself refreshing usage (e.g. its settings page) — piggyback,
    // but never more than every 15s.
    if (pathname.endsWith('/usage') && !polling && Date.now() - lastPollAt > 15_000) schedulePoll(0);
  },
  { urls: ['*://claude.ai/api/organizations/*'] }
);

chrome.alarms.create('clautics_poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'clautics_poll') runPoll();
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only accept messages from this extension's own popup/content scripts,
  // never from arbitrary web pages (defense in depth alongside the fact
  // that externally_connectable is not configured in manifest.json).
  if (sender.id !== chrome.runtime.id) return false;

  if (msg.type === 'clautics_get') {
    load().then(reply);
    return true;
  }
  if (msg.type === 'clautics_poll') {
    runPoll({ force: true }).then(() => load()).then(reply);
    return true;
  }
  if (msg.type === 'clautics_activate') {
    if (typeof msg.key !== 'string' || msg.key.trim().length === 0 || msg.key.length > 200) {
      reply({ valid: false, error: chrome.i18n.getMessage('licenseErrInvalidFormat') });
      return true;
    }
    activateLicense(msg.key.trim()).then(async (valid) => {
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

// ── Updates ────────────────────────────────────────────────────────────────
// Clautics ships through the Chrome Web Store, so Chrome downloads new
// versions on its own (roughly every 5 hours, and on browser start). What it
// does NOT do on its own is make that update land cleanly in tabs that are
// already open, which is what the two listeners below are for.

// Chrome holds a downloaded update until every extension context is idle, and
// a service worker woken every minute by an alarm is rarely idle — an update
// could sit unapplied for a long time. Taking it immediately is safe here:
// all state lives in chrome.storage, so there is nothing in memory to lose.
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

// The instant an update applies, the content script in every open claude.ai
// tab is orphaned: its panel stays on screen but every chrome.* call throws
// "Extension context invalidated", so the numbers silently freeze until the
// user happens to reload. Swap in the new build instead of reloading the tab,
// which would throw away whatever the user had typed into Claude.
async function reinjectContentScripts() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: '*://claude.ai/*' }); } catch { return; }

  for (const tab of tabs) {
    try {
      // page.js bails out if #clautics-root already exists, so the stale panel
      // left behind by the previous version has to go first.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.getElementById('clautics-root')?.remove(),
      });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT_CSS });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_JS });
    } catch (err) {
      // Tab closed, navigated away, or is a page we can't touch — skip it.
      console.warn('Clautics: could not refresh panel in tab', tab.id, err);
    }
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  validateLicense();
  runPoll({ force: true });
  if (reason === 'update') reinjectContentScripts();
});

chrome.runtime.onStartup.addListener(() => { validateLicense(); runPoll({ force: true }); });
