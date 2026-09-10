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
      extraUsage:   chrome.i18n.getMessage('labelExtraUsage'),
    };
  },

  ORDER: ['session', 'weekly', 'sonnetWeekly', 'opusWeekly', 'extraUsage'],

  get TIERS() {
    return {
      free:    chrome.i18n.getMessage('tierFree'),
      pro:     chrome.i18n.getMessage('tierPro'),
      team:    chrome.i18n.getMessage('tierTeam'),
      max_5x:  chrome.i18n.getMessage('tierMax5x'),
      max_20x: chrome.i18n.getMessage('tierMax20x'),
    };
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
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h >= 24) return chrome.i18n.getMessage('countdownDaysHours', [String(Math.floor(h / 24)), String(h % 24)]);
    if (h === 0) return chrome.i18n.getMessage('countdownMinutes', [String(m)]);
    return chrome.i18n.getMessage('countdownHoursMinutes', [String(h), String(m)]);
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
