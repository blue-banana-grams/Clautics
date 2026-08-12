// Clautics — src/common.js
// Helpers that all three contexts need. Loaded first everywhere: as the first
// entry of the content_scripts js array, as a <script> above popup.js, and via
// importScripts() in the service worker. Previously each of these lived in two
// or three copies that had to be kept in sync by hand.
'use strict';

const CLY = {
  LABELS: {
    session:      '5-hr session',
    weekly:       'Weekly',
    sonnetWeekly: 'Sonnet weekly',
    opusWeekly:   'Opus weekly',
    extraUsage:   'Extra usage',
  },

  ORDER: ['session', 'weekly', 'sonnetWeekly', 'opusWeekly', 'extraUsage'],

  TIERS: { free: 'Free', pro: 'Pro', team: 'Team', max_5x: 'Max 5×', max_20x: 'Max 20×' },

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
    if (ms <= 0) return 'resetting…';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h === 0 ? `${m}m` : `${h}h ${m}m`;
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

    if (isWeekday && isBizHours && isYourPeak) return { show: true, text: 'Peak hours — Claude may be slower', icon: '🔴' };
    if (isWeekday && isBizHours)               return { show: true, text: 'Typical peak hours for Claude',    icon: '⚠️' };
    if (isYourPeak)                            return { show: true, text: 'Above your usual usage rate',      icon: '📈' };
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
