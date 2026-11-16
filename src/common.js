// Clautics — src/common.js
// Helpers that all three contexts need. Loaded first everywhere: as the first
// entry of the content_scripts js array, as a <script> above popup.js, and via
// importScripts() in the service worker. Previously each of these lived in two
// or three copies that had to be kept in sync by hand.
//
// All user-facing text goes through chrome.i18n.getMessage() — see
// _locales/<lang>/messages.json — so LABELS/TIERS are getters (re-read on
// every access) rather than plain objects, keeping every existing
// `CLY.LABELS[key]` / `CLY.TIERS[key]` call site unchanged.
'use strict';

const CLY = {
  get LABELS() {
    return {
      session:      chrome.i18n.getMessage('labelSession'),
      weekly:       chrome.i18n.getMessage('labelWeekly'),
      sonnetWeekly: chrome.i18n.getMessage('labelSonnetWeekly'),
      opusWeekly:   chrome.i18n.getMessage('labelOpusWeekly'),
      fableWeekly:  chrome.i18n.getMessage('labelFableWeekly'),
      extraUsage:   chrome.i18n.getMessage('labelExtraUsage'),
    };
  },

  // Display order for the limits we know about. Any other per-model weekly
  // bucket the API starts returning (see parseLimits in worker.js) is shown
  // after these, before extra usage — see ordered().
  ORDER: ['session', 'weekly', 'fableWeekly', 'opusWeekly', 'sonnetWeekly', 'extraUsage'],

  ordered(limits) {
    if (!limits) return [];
    const keys = Object.keys(limits).filter((k) => limits[k] != null);
    const rank = (k) => {
      const i = CLY.ORDER.indexOf(k);
      return i >= 0 ? (k === 'extraUsage' ? 1000 : i) : 500;
    };
    return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((k) => [k, limits[k]]);
  },

  // Label for a limit key, including per-model weekly buckets we don't have a
  // dedicated translation for ("haikuWeekly" → "Haiku weekly").
  label(key) {
    const known = CLY.LABELS[key];
    if (known) return known;
    const m = /^(.+)Weekly$/.exec(key);
    if (m) return chrome.i18n.getMessage('labelModelWeekly', [m[1].charAt(0).toUpperCase() + m[1].slice(1)]);
    return key;
  },

  get TIERS() {
    return {
      free:    chrome.i18n.getMessage('tierFree'),
      pro:     chrome.i18n.getMessage('tierPro'),
      team:    chrome.i18n.getMessage('tierTeam'),
      max_5x:  chrome.i18n.getMessage('tierMax5x'),
      ultra:   chrome.i18n.getMessage('tierUltra'),
      // Max 20× was renamed Ultra; kept so state saved by older versions
      // still shows a name.
      max_20x: chrome.i18n.getMessage('tierUltra'),
    };
  },

  // A span of time as "2d 4h" / "3h 10m" / "25m" (no "resetting" wording).
  duration(ms) {
    if (!(ms > 0)) return chrome.i18n.getMessage('countdownMinutes', ['0']);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h >= 24) return chrome.i18n.getMessage('countdownDaysHours', [String(Math.floor(h / 24)), String(h % 24)]);
    if (h === 0) return chrome.i18n.getMessage('countdownMinutes', [String(m)]);
    return chrome.i18n.getMessage('countdownHoursMinutes', [String(h), String(m)]);
  },

  // Returns a severity name, not a literal colour. The popup and the on-page
  // panel each map it onto their own CSS custom property, so a percentage is
  // classified in one place while both surfaces still follow their own theme
  // (the popup used to hard-code the dark-theme hexes even in light mode).
  level(pct) {
    return pct >= 95 ? 'warn' : pct >= 80 ? 'caution' : 'accent';
  },

  countdown(ts) {
    if (!ts) return '';
    const ms = ts - Date.now();
    if (ms <= 0) return chrome.i18n.getMessage('resetting');
    return CLY.duration(ms);
  },

  // Extra-usage spend: "$4.20 / $50.00", or just "$4.20" with no monthly cap.
  money(usedCents, limitCents) {
    const fmt = (c) => `$${(c / 100).toFixed(2)}`;
    return limitCents != null ? `${fmt(usedCents)} / ${fmt(limitCents)}` : fmt(usedCents);
  },

  dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  peakInfo(heatmap) {
    const now = new Date();
    const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
    const isBizHours = now.getHours() >= 9 && now.getHours() < 18;
    const epochHour  = Math.floor(Date.now() / 3_600_000);
    const hm         = heatmap || [];

    let sum = 0, n = 0, nowDelta = 0;
    for (const h of hm) {
      if (h.hour === epochHour) nowDelta = h.delta;
      else if (h.hour > epochHour - 24 && h.hour < epochHour) { sum += h.delta; n++; }
    }
    const avg = n ? sum / n : 0;
    const isYourPeak = avg > 0 && nowDelta > avg * 1.4;

    if (isWeekday && isBizHours && isYourPeak) return { show: true, text: chrome.i18n.getMessage('peakHoursSlower'),  icon: '🔴' };
    if (isWeekday && isBizHours)               return { show: true, text: chrome.i18n.getMessage('peakHoursTypical'), icon: '⚠️' };
    if (isYourPeak)                            return { show: true, text: chrome.i18n.getMessage('aboveUsualRate'),   icon: '📈' };
    return { show: false };
  },

  renderPeak(banner, heatmap, visibleClass) {
    if (!banner) return;
    const info = CLY.peakInfo(heatmap);
    banner.classList.toggle(visibleClass, info.show);
    if (!info.show) return;
    banner.querySelector('.cly-pk-i').textContent = info.icon;
    banner.querySelector('.cly-pk-t').textContent = info.text;
  },

  // Escapes " so a translated string can never break out of the HTML
  // attribute it's being interpolated into (title="…") when building markup
  // via innerHTML. Translated prose routinely contains apostrophes/quotes —
  // unlike the original hard-coded English strings, these aren't ours to
  // guarantee are quote-free.
  attr(s) {
    return String(s).replace(/"/g, '&quot;');
  },

  // setInterval that stops itself once the extension context goes away — which
  // is exactly what happens to an already-open claude.ai tab the moment an
  // update installs. Without this the orphaned page keeps ticking and throwing
  // "Extension context invalidated" every 20 seconds until it is reloaded.
  interval(fn, ms) {
    const id = setInterval(() => {
      if (!chrome.runtime?.id) return clearInterval(id);
      fn();
    }, ms);
    return id;
  },
};
