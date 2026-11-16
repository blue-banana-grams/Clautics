// Clautics — src/coach.js
// The usage coach: turns the raw limit percentages, the usage samples the
// worker records over time, and the measured cost of each message into
// (1) a pace analysis per limit, (2) one headline telling the user the single
// most useful thing right now, and (3) a short list of tips picked for the
// situation they're actually in.
//
// The goal it optimises for is "finish every window at ~100%": running out
// early means being locked out, finishing at 40% means paying for capacity
// that was never used. So it warns about burning too fast AND tells the user
// when they have room to spare.
//
// Pure functions over the stored state — no DOM, no storage, no network — so
// the popup, the on-page panel and the worker (pace notifications) all share
// it, and it can be unit-tested with a stubbed chrome.i18n. Loaded right after
// common.js everywhere.
'use strict';

const COACH = (() => {
  const MIN  = 60_000;
  const HOUR = 60 * MIN;
  const DAY  = 24 * HOUR;

  // How long each window is. Only the session is 5 hours; every weekly bucket
  // (all models, and per-model ones such as Fable) is 7 days.
  const windowMs = (key) => (key === 'session' ? 5 * HOUR : 7 * DAY);

  const t = (k, args) => chrome.i18n.getMessage(k, args);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v) => String(Math.round(v));
  const oneDecimal = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));

  // Two resets_at values describe the same window if they're within a few
  // minutes of each other (the API returns sub-second jitter).
  const sameWindow = (a, b) => !!a && !!b && Math.abs(a - b) < 10 * MIN;

  // The limit we measure "cost per message" against: the 5-hour session when
  // the plan has one, otherwise the weekly limit (verified Ultra accounts have
  // no session limit).
  function primaryKey(limits) {
    if (limits?.session) return 'session';
    if (limits?.weekly) return 'weekly';
    return null;
  }

  // ── Pace for one limit ──────────────────────────────────────────────────

  function analyzeLimit(key, limit, samples, now) {
    const pct = limit.pct ?? 0;
    const out = { key, pct, status: 'ok', pacePct: null, runOutAt: null, projected: null };

    if (pct >= 100) out.status = 'hit';
    const remainingMs = limit.resetsAt ? limit.resetsAt - now : null;
    if (remainingMs == null || remainingMs <= 0) {
      // A session with no reset time hasn't started — the whole allowance is
      // available. Nothing to pace against.
      if (out.status !== 'hit') out.status = 'idle';
      return out;
    }

    const W = windowMs(key);
    const elapsedMs = clamp(W - remainingMs, 0, W);
    const elapsedFrac = elapsedMs / W;
    out.pacePct = elapsedFrac * 100;      // where an even pace would be right now
    out.remainingMs = remainingMs;
    out.elapsedFrac = elapsedFrac;

    // Average burn over the window so far.
    const avgRate = elapsedMs > 5 * MIN ? pct / elapsedMs : 0;

    // Recent burn over the last hour, from the worker's samples.
    let recentRate = null;
    const ss = (samples || []).filter((s) => sameWindow(s[2], limit.resetsAt) && now - s[0] <= HOUR);
    if (ss.length) {
      const [t0, p0] = ss[0];
      if (now - t0 >= 5 * MIN) recentRate = Math.max(0, (pct - p0) / (now - t0));
    }

    // A 5-hour session is short enough that "how fast am I going right now"
    // is the right predictor. A week includes nights and days off, so the
    // whole-week average is the honest one there.
    const rate = key === 'session' && recentRate != null ? recentRate : avgRate;
    out.rate = rate;
    out.projected = pct + rate * remainingMs;

    if (out.status === 'hit') return out;

    if (rate > 0) {
      const runOutAt = now + (100 - pct) / rate;
      // Only a warning if it lands meaningfully before the reset, and — for a
      // weekly limit — once there's enough of the week to judge from.
      const enoughData = key === 'session' || elapsedFrac >= 0.1 || pct >= 50;
      if (runOutAt < limit.resetsAt - 5 * MIN && enoughData) {
        out.runOutAt = runOutAt;
        out.status = 'risk';
        return out;
      }
    }

    // Use-it-or-lose-it: past the middle of the week and tracking to finish
    // well short of the allowance.
    if (key !== 'session' && elapsedFrac >= 0.5 && out.projected < 75) out.status = 'under';
    return out;
  }

  // ── Cost per message ────────────────────────────────────────────────────
  // state.msgCosts = [[time, pctOfPrimaryLimit, conversationId], ...]
  // written by the worker, which splits each change in the primary limit
  // across the messages sent since the previous reading.

  function costStats(state) {
    const costs = (state.msgCosts || []).slice(-40);
    if (costs.length < 4) return null;
    const vals = costs.map((c) => c[1]);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { avg, median, n: vals.length };
  }

  // The conversation the user is in right now, if they messaged in it lately.
  function currentConversation(state, now) {
    const last = state.lastConv;
    if (!last || now - last.t > 45 * MIN) return null;
    const c = state.convCost?.[last.id];
    if (!c) return null;
    return { id: last.id, n: c.n, perMsg: c.measured ? c.pct / c.measured : null, measured: c.measured || 0 };
  }

  // ── Weekly daily budget ─────────────────────────────────────────────────
  // How much of the weekly limit can be spent per day and still last to the
  // reset, and how much of it has already been spent today.

  function dailyBudget(limit, samples, now) {
    if (!limit?.resetsAt || limit.resetsAt <= now) return null;
    const pct = limit.pct ?? 0;
    const daysLeft = (limit.resetsAt - now) / DAY;
    const perDay = daysLeft <= 1 ? 100 - pct : (100 - pct) / daysLeft;

    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const dayStart = startOfToday.getTime();
    const windowStart = limit.resetsAt - 7 * DAY;
    let base = null;
    if (windowStart >= dayStart) base = 0;
    else {
      const ss = (samples || []).filter((s) => sameWindow(s[2], limit.resetsAt));
      const before = ss.filter((s) => s[0] <= dayStart).pop();
      const firstToday = ss.find((s) => s[0] > dayStart);
      base = before ? before[1] : firstToday ? firstToday[1] : null;
    }
    const usedToday = base == null ? null : Math.max(0, pct - base);
    return { perDay: Math.max(0, perDay), usedToday, daysLeft };
  }

  // ── Plan strategy ───────────────────────────────────────────────────────

  const STRATEGY = {
    free:    'strategyFree',
    pro:     'strategyPro',
    max_5x:  'strategyMax',
    ultra:   'strategyUltra',
    max_20x: 'strategyUltra', // Max 20× was renamed Ultra
    team:    'strategyTeam',
  };

  // ── Tips ────────────────────────────────────────────────────────────────

  // Always-useful habits from Anthropic's own usage-limit guidance, rotated
  // daily so the list doesn't look frozen.
  const GENERAL_TIPS = ['tipBatch', 'tipProjects', 'tipEditPrompt', 'tipContextUpfront', 'tipSharedLimits', 'tipTools'];

  // ── Main entry point ────────────────────────────────────────────────────

  function analyze(state, now = Date.now()) {
    const limits = state?.limits;
    const result = { headline: null, tips: [], pace: {}, primary: null, messagesLeft: null, budget: null, strategy: null, conv: null };

    if (!limits) {
      result.headline = { level: 'info', icon: '⏳', title: t('coachWaitingTitle'), detail: t('coachWaitingDetail') };
      return result;
    }

    const samples = state.samples || {};
    for (const key of Object.keys(limits)) {
      if (key === 'extraUsage' || !limits[key]) continue;
      result.pace[key] = analyzeLimit(key, limits[key], samples[key], now);
    }

    const primary = primaryKey(limits);
    result.primary = primary;
    const stats = costStats(state);
    if (primary && stats && stats.avg >= 0.05) {
      const left = Math.max(0, 100 - (limits[primary].pct ?? 0));
      result.messagesLeft = { n: Math.floor(left / stats.avg), perMsg: stats.avg, key: primary };
    }
    if (limits.weekly) result.budget = dailyBudget(limits.weekly, samples.weekly, now);

    const strategyKey = STRATEGY[state.tier];
    if (strategyKey) result.strategy = t(strategyKey);

    const conv = currentConversation(state, now);
    result.conv = conv;

    const label = (key) => CLY.label(key);
    const paces = Object.values(result.pace);
    const hit = paces.find((p) => p.status === 'hit');
    const sessionRisk = result.pace.session?.status === 'risk' ? result.pace.session : null;
    const weeklyRisk = paces.find((p) => p.key !== 'session' && p.status === 'risk');
    const under = result.pace.weekly?.status === 'under' ? result.pace.weekly : null;

    // An expensive conversation: each message costs at least twice the user's
    // usual, or it's simply very long. Long chats re-send everything above,
    // and once automatic context management kicks in they cost even more.
    let expensive = null;
    if (conv) {
      const baseline = stats?.median || stats?.avg || 0;
      if (conv.measured >= 3 && conv.perMsg != null && conv.perMsg >= 1 &&
          ((baseline > 0 && conv.perMsg >= 2 * baseline) || conv.perMsg >= 4)) {
        expensive = { kind: 'cost', perMsg: conv.perMsg, ratio: baseline > 0 ? conv.perMsg / baseline : null };
      } else if (conv.n >= 30) {
        expensive = { kind: 'long', n: conv.n };
      }
    }

    // ── Headline: the single most important thing right now ──
    if (hit) {
      const lim = limits[hit.key];
      result.headline = {
        level: 'warn', icon: '⛔',
        title: t('coachHitTitle', [label(hit.key)]),
        detail: lim.resetsAt ? t('coachHitDetail', [CLY.countdown(lim.resetsAt)]) : t('coachHitDetailNoReset'),
      };
    } else if (sessionRisk) {
      const eta = sessionRisk.runOutAt - now;
      result.headline = {
        level: eta < HOUR ? 'warn' : 'caution', icon: '🔥',
        title: t('coachRiskTitle', [label('session'), CLY.duration(eta)]),
        detail: t('coachRiskSessionDetail', [CLY.duration(limits.session.resetsAt - sessionRisk.runOutAt)]),
      };
    } else if (weeklyRisk) {
      const eta = weeklyRisk.runOutAt - now;
      const b = weeklyRisk.key === 'weekly' ? result.budget : dailyBudget(limits[weeklyRisk.key], samples[weeklyRisk.key], now);
      result.headline = {
        level: eta < DAY ? 'warn' : 'caution', icon: '📉',
        title: t('coachRiskTitle', [label(weeklyRisk.key), CLY.duration(eta)]),
        detail: t('coachRiskWeeklyDetail', [CLY.duration(limits[weeklyRisk.key].resetsAt - weeklyRisk.runOutAt), oneDecimal(b?.perDay ?? 0)]),
      };
    } else if (expensive) {
      result.headline = expensive.kind === 'cost'
        ? { level: 'caution', icon: '💸', title: t('coachExpensiveTitle'),
            detail: expensive.ratio
              ? t('coachExpensiveDetail', [oneDecimal(expensive.perMsg), oneDecimal(expensive.ratio)])
              : t('coachExpensiveDetailNoRatio', [oneDecimal(expensive.perMsg)]) }
        : { level: 'caution', icon: '🧵', title: t('coachLongTitle'), detail: t('coachLongDetail', [String(expensive.n)]) };
    } else if (under) {
      result.headline = {
        level: 'good', icon: '🎯',
        title: t('coachUnderTitle', [round(100 - under.pct), CLY.countdown(limits.weekly.resetsAt)]),
        detail: t('coachUnderDetail', [round(under.projected)]),
      };
    } else {
      const ml = result.messagesLeft;
      result.headline = {
        level: 'good', icon: '✅',
        title: t('coachOnPaceTitle'),
        detail: ml
          ? t(ml.key === 'session' ? 'coachMsgsLeftSession' : 'coachMsgsLeftWeekly', [String(ml.n)])
          : t('coachOnPaceDetail'),
      };
    }

    // ── Tips: situational first, then general habits to fill up to three ──
    const tips = [];
    const add = (key, args) => { if (tips.length < 3 && !tips.some((x) => x.key === key)) tips.push({ key, text: t(key, args) }); };

    // Most specific first: what fixes the exact limit that's in trouble.
    if (expensive) add('tipNewChat');
    if (hit && state.tier !== 'free') add('tipCredits');
    const fable = result.pace.fableWeekly;
    if (fable && fable.pct >= 50 && fable.status !== 'under') add('tipFable', [round(fable.pct)]);
    if (weeklyRisk?.key === 'weekly' && result.budget) add('tipBudget', [oneDecimal(result.budget.perDay)]);
    const tight = hit || sessionRisk || weeklyRisk || (result.pace.session?.pct ?? 0) >= 70;
    if (tight) {
      add('tipModel');
      add('tipEffort');
      add('tipTools');
    }
    if (under) add('tipUnder');

    const day = Math.floor(now / DAY);
    for (let i = 0; tips.length < 3 && i < GENERAL_TIPS.length; i++) {
      add(GENERAL_TIPS[(day + i) % GENERAL_TIPS.length]);
    }
    result.tips = tips;
    return result;
  }

  // Whether a pace notification should go out for this limit right now —
  // close enough to running out that the user can still change course.
  function paceAlertDue(p, now = Date.now()) {
    if (p?.status !== 'risk' || !p.runOutAt) return false;
    const eta = p.runOutAt - now;
    return p.key === 'session' ? eta <= HOUR : eta <= DAY;
  }

  return { analyze, analyzeLimit, dailyBudget, costStats, primaryKey, paceAlertDue, sameWindow, windowMs };
})();
