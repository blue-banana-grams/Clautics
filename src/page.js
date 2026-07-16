// Clautics — src/page.js
// Injected into claude.ai. Builds and updates the floating sidebar panel.

(function () {
  'use strict';
  if (document.getElementById('clautics-root')) return;

  // ── Panel size presets ───────────────────────────────────────────────
  // The permanent default lives in chrome.storage (set from the toolbar
  // popup's Settings view) and applies every time the panel is (re)opened.
  // Manual edge-dragging during a session is temporary: it never persists
  // across a reload or a minimize/restore cycle, so the panel always comes
  // back to this default instead of getting stuck at some odd size.

  const PANEL_SIZE_KEY = 'cly_panel_width';
  const PANEL_WIDTHS = { compact: 190, default: 218, large: 280 };
  let defaultWidth = PANEL_WIDTHS.default;

  const RESIZE_MIN_WIDTH  = 160;
  const RESIZE_MAX_WIDTH  = 360;
  const RESIZE_MIN_HEIGHT = 90;
  const RESIZE_MAX_HEIGHT = 560;

  // ── Panel DOM ──────────────────────────────────────────────────────────

  const root = document.createElement('div');
  root.id = 'clautics-root';
  root.innerHTML = `
    <div id="cly-header">
      <span id="cly-logo">◈</span>
      <span id="cly-name">Clautics</span>
      <button class="cly-hd-btn" id="cly-theme"    title="Toggle light/dark">☀️</button>
      <button class="cly-hd-btn" id="cly-collapse" title="Minimize">−</button>
    </div>
    <div id="cly-body">
      <div id="cly-limits"></div>
      <div id="cly-peak-banner">
        <span id="cly-peak-icon">⚠️</span>
        <span id="cly-peak-text"></span>
      </div>
      <div id="cly-footer">
        <span id="cly-tier-badge"></span>
        <span id="cly-updated"></span>
      </div>
    </div>
    <button id="cly-mini-btn" title="Expand Clautics">
      <span id="cly-mini-dot"></span>
    </button>
  `;
  document.body.appendChild(root);

  // ── Restore saved position (size is intentionally not persisted) ───────

  try {
    const saved = JSON.parse(localStorage.getItem('cly_pos') || 'null');
    if (saved) {
      if (saved.top)   root.style.top   = saved.top;
      if (saved.right) root.style.right = saved.right;
    }
  } catch {}

  function applyDefaultWidth() {
    root.style.width = `${defaultWidth}px`;
    root.style.height = '';
  }
  applyDefaultWidth();

  chrome.storage.local.get(PANEL_SIZE_KEY, (r) => {
    const pref = r[PANEL_SIZE_KEY];
    if (pref && PANEL_WIDTHS[pref] && !mini) {
      defaultWidth = PANEL_WIDTHS[pref];
      if (!resize) applyDefaultWidth();
    }
  });

  // ── Minimize / expand (whole panel becomes a small square button) ──────

  let mini = false;

  function setMini(next) {
    mini = next;
    root.classList.toggle('cly-mini', mini);
    if (mini) {
      root.dataset.expandedTop = root.style.top;
    } else {
      // Reset to the default size every time the panel is (re)opened.
      applyDefaultWidth();
    }
  }

  document.getElementById('cly-collapse').addEventListener('click', () => setMini(true));
  document.getElementById('cly-mini-btn').addEventListener('click', () => setMini(false));

  // ── Draggable ─────────────────────────────────────────────────────────

  const header = document.getElementById('cly-header');
  let dragging = false, dragStartX, dragStartY, panelStartRight, panelStartTop;

  header.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('cly-hd-btn')) return;
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    const rect = root.getBoundingClientRect();
    panelStartRight = window.innerWidth - rect.right;
    panelStartTop   = rect.top;
    root.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    root.style.right  = `${Math.max(0, Math.min(window.innerWidth  - 80, panelStartRight - dx))}px`;
    root.style.top    = `${Math.max(0, Math.min(window.innerHeight - 60, panelStartTop   + dy))}px`;
    root.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    root.style.transition = '';
    try {
      localStorage.setItem('cly_pos', JSON.stringify({ right: root.style.right, top: root.style.top }));
    } catch {}
  });

  // ── Resizable (drag the edges/corners) — session-only, never persisted ─

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  let resize = null;

  function beginResize(edge, e) {
    if (mini) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = root.getBoundingClientRect();
    resize = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      startTop: rect.top,
      startRightGap: window.innerWidth - rect.right,
    };
    root.classList.add('cly-resizing');
  }

  document.addEventListener('mousemove', (e) => {
    if (!resize) return;
    const { edge, startX, startY, startWidth, startHeight, startTop, startRightGap } = resize;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (edge.includes('e')) {
      const newWidth = clamp(startWidth + dx, RESIZE_MIN_WIDTH, RESIZE_MAX_WIDTH);
      root.style.width = `${newWidth}px`;
      root.style.right = `${startRightGap - (newWidth - startWidth)}px`;
    } else if (edge.includes('w')) {
      const newWidth = clamp(startWidth - dx, RESIZE_MIN_WIDTH, RESIZE_MAX_WIDTH);
      root.style.width = `${newWidth}px`;
      root.style.right = `${startRightGap}px`;
    }

    if (edge.includes('s')) {
      const newHeight = clamp(startHeight + dy, RESIZE_MIN_HEIGHT, RESIZE_MAX_HEIGHT);
      root.style.height = `${newHeight}px`;
      root.style.top    = `${startTop}px`;
    } else if (edge.includes('n')) {
      const newHeight = clamp(startHeight - dy, RESIZE_MIN_HEIGHT, RESIZE_MAX_HEIGHT);
      root.style.height = `${newHeight}px`;
      root.style.top    = `${(startTop + startHeight) - newHeight}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (!resize) return;
    const { edge } = resize;
    root.classList.remove('cly-resizing');

    // Never leave dead space: if the panel was stretched taller than its
    // content actually needs, snap the height back down to fit instead of
    // keeping a mostly-empty box. Shrinking below content height is fine —
    // the body just scrolls (see #cly-body { overflow-y: auto }).
    //
    // #cly-body is flex:1 with overflow-y:auto, so its scrollHeight can't be
    // read while root is still forced to the dragged (possibly oversized)
    // height — an auto-overflow element's scrollHeight is never smaller than
    // its own current clientHeight, which would just echo the dragged size
    // back. Temporarily go auto to get a clean natural-size measurement.
    if (edge.includes('n') || edge.includes('s')) {
      const draggedHeight = root.style.height;
      const draggedBottom = root.getBoundingClientRect().bottom;
      const draggedBoxHeight = root.getBoundingClientRect().height;

      root.style.height = '';
      const naturalBoxHeight = root.getBoundingClientRect().height;

      if (draggedBoxHeight > naturalBoxHeight + 0.5) {
        // Natural content is shorter than what was dragged — stay auto.
        if (edge.includes('n')) {
          // Top was moving; keep the bottom edge anchored when snapping.
          root.style.top = `${draggedBottom - naturalBoxHeight}px`;
        }
      } else {
        // Deliberately shrunk below content height — keep it, body scrolls.
        root.style.height = draggedHeight;
      }
    }

    resize = null;
    try {
      localStorage.setItem('cly_pos', JSON.stringify({ right: root.style.right, top: root.style.top }));
    } catch {}
  });

  ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `cly-resize-handle cly-resize-${edge}`;
    handle.addEventListener('mousedown', (e) => beginResize(edge, e));
    root.appendChild(handle);
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  const LABEL = {
    session:      '5-hr session',
    weekly:       'Weekly',
    sonnetWeekly: 'Sonnet weekly',
    opusWeekly:   'Opus weekly',
    extraUsage:   'Extra usage',
  };

  function pctColor(pct) {
    if (pct >= 95) return 'var(--cly-warn)';
    if (pct >= 80) return 'var(--cly-caution)';
    return 'var(--cly-accent)';
  }

  function fmtCountdown(ts) {
    if (!ts) return '';
    const ms = ts - Date.now();
    if (ms <= 0) return 'resetting…';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  }

  function fmtDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  // ── Render limits ─────────────────────────────────────────────────────

  let currentLimits = {};

  function renderLimits(limits) {
    currentLimits = limits || {};
    const container = document.getElementById('cly-limits');
    container.innerHTML = '';
    const entries = Object.entries(currentLimits).filter(([, v]) => v !== null);
    if (!entries.length) {
      container.innerHTML = '<div class="cly-empty">No limits found.<br>Open a conversation first.</div>';
      renderMiniDot();
      return;
    }
    for (const [key, limit] of entries) {
      const pct   = limit.pct ?? 0;
      const color = pctColor(pct);
      const row = document.createElement('div'); row.className = 'cly-limit-row';
      const top = document.createElement('div'); top.className = 'cly-limit-top';
      top.innerHTML = `<span class="cly-limit-label">${LABEL[key] || key}</span>
                       <span class="cly-limit-pct" style="color:${color}">${pct.toFixed(0)}%</span>`;
      const track = document.createElement('div'); track.className = 'cly-track';
      const fill  = document.createElement('div'); fill.className = 'cly-fill';
      fill.style.width = `${Math.min(pct, 100)}%`; fill.style.background = color;
      track.appendChild(fill);
      const meta = document.createElement('div'); meta.className = 'cly-limit-meta';
      if (key === 'extraUsage' && limit.usedCents != null) {
        meta.textContent = `$${(limit.usedCents/100).toFixed(2)} / $${(limit.limitCents/100).toFixed(2)}`;
      } else if (limit.resetsAt) {
        meta.innerHTML = `<span class="cly-reset-label" data-ts="${limit.resetsAt}">↺ ${fmtCountdown(limit.resetsAt)}</span>`;
      }
      row.appendChild(top); row.appendChild(track); row.appendChild(meta);
      container.appendChild(row);
    }
    renderMiniDot();
  }

  // ── Mini dot (reflects the highest active limit while minimized) ───────

  function renderMiniDot() {
    const dot = document.getElementById('cly-mini-dot');
    if (!dot) return;
    let topPct = 0;
    for (const v of Object.values(currentLimits)) {
      if (v && typeof v.pct === 'number' && v.pct > topPct) topPct = v.pct;
    }
    dot.style.backgroundColor = pctColor(topPct);
  }

  // ── Peak banner ───────────────────────────────────────────────────────

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
    const banner = document.getElementById('cly-peak-banner');
    const info   = getPeakInfo(heatmap);
    if (info.show) {
      document.getElementById('cly-peak-text').textContent = info.text;
      document.getElementById('cly-peak-icon').textContent = info.icon;
      banner.classList.add('cly-peak-visible');
    } else {
      banner.classList.remove('cly-peak-visible');
    }
  }

  // ── Daily stats ───────────────────────────────────────────────────────

  function renderDailyStats(dailyUsage) {
    const du    = dailyUsage || {};
    const today = new Date(); today.setHours(0,0,0,0);

    const todayVal = du[fmtDateKey(today)] || 0;

    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      if ((du[fmtDateKey(d)] || 0) > 0) streak++; else break;
    }

    const vals = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const v = du[fmtDateKey(d)] || 0;
      if (v > 0) vals.push(v);
    }
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

    const todayEl = document.getElementById('cly-today');
    const streakEl = document.getElementById('cly-streak');
    const avgEl = document.getElementById('cly-avg');
    if (todayEl)  todayEl.textContent  = todayVal > 0 ? String(todayVal) : '—';
    if (streakEl) streakEl.textContent = streak > 0   ? `${streak}🔥`   : '—';
    if (avgEl)    avgEl.textContent    = avg > 0       ? avg.toFixed(1)  : '—';
  }

  // ── Footer ────────────────────────────────────────────────────────────

  function renderFooter(state) {
    const tierEl    = document.getElementById('cly-tier-badge');
    const updatedEl = document.getElementById('cly-updated');
    const tierMap   = { free: 'Free', pro: 'Pro', team: 'Team', max_5x: 'Max 5×', max_20x: 'Max 20×', unknown: '' };
    tierEl.textContent   = tierMap[state.tier] || '';
    tierEl.style.display = state.tier && state.tier !== 'unknown' ? 'inline-block' : 'none';
    if (state.fetchedAt) {
      const ago = Math.round((Date.now() - state.fetchedAt) / 1000);
      updatedEl.textContent = ago < 10 ? 'just now' : `${ago}s ago`;
    }
  }

  // ── Countdowns ────────────────────────────────────────────────────────

  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      el.textContent = `↺ ${fmtCountdown(parseInt(el.dataset.ts))}`;
    });
    if (lastState) renderFooter(lastState);
  }, 20_000);

  // ── State ─────────────────────────────────────────────────────────────

  let lastState = null;

  function applyState(state) {
    if (!state) return;
    lastState = state;
    if (state.limits) renderLimits(state.limits);
    renderPeakBanner(state.heatmap);
    renderFooter(state);
  }

  // ── Init ──────────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'clautics_get' }, applyState);

  // ── Theme ─────────────────────────────────────────────────────────────

  const THEME_KEY = 'clautics_theme';

  function applyPanelTheme(theme) {
    root.setAttribute('data-theme', theme);
    root.style.backgroundColor = theme === 'light' ? '#f9f9f8' : '#1e1e1e';
    const btn = document.getElementById('cly-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  chrome.storage.local.get(THEME_KEY, (r) => applyPanelTheme(r[THEME_KEY] || 'dark'));

  document.getElementById('cly-theme').addEventListener('click', () => {
    const next = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
    applyPanelTheme(next);
    chrome.storage.local.set({ [THEME_KEY]: next });
    chrome.runtime.sendMessage({ type: 'clautics_theme', theme: next }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'clautics_theme')  applyPanelTheme(msg.theme);
    if (msg.type === 'clautics_update') applyState(msg.data);
    if (msg.type === 'clautics_panel_size' && PANEL_WIDTHS[msg.size]) {
      defaultWidth = PANEL_WIDTHS[msg.size];
      if (!mini && !resize) applyDefaultWidth();
    }
  });

})();
