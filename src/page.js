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
  const POS_KEY = 'cly_pos';

  const MIN_W = 160, MAX_W = 360, MIN_H = 90, MAX_H = 560;

  let defaultWidth = PANEL_WIDTHS.default;
  let mini = false;
  let gesture = null;   // the in-progress drag or resize, if any

  // ── Panel DOM ──────────────────────────────────────────────────────────

  const root = document.createElement('div');
  root.id = 'clautics-root';
  root.innerHTML = `
    <div id="cly-header">
      <span id="cly-logo">◈</span>
      <span id="cly-name">Clautics</span>
      <button class="cly-hd-btn" id="cly-theme"    title="${CLY.attr(chrome.i18n.getMessage('themeToggleTitle'))}">☀️</button>
      <button class="cly-hd-btn" id="cly-collapse" title="${CLY.attr(chrome.i18n.getMessage('minimizeTitle'))}">−</button>
    </div>
    <div id="cly-body">
      <div id="cly-limits"></div>
      <div id="cly-peak-banner">
        <span class="cly-pk-i">⚠️</span>
        <span class="cly-pk-t"></span>
      </div>
      <div id="cly-footer">
        <span id="cly-tier-badge"></span>
        <span id="cly-updated"></span>
      </div>
    </div>
    <button id="cly-mini-btn" title="${CLY.attr(chrome.i18n.getMessage('miniBtnTitle'))}">
      <svg id="cly-mini-logo" viewBox="0 0 100 100" aria-label="Clautics" role="img">
        <defs>
          <linearGradient id="cly-mini-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#e0a48c"/>
            <stop offset="1" stop-color="#cc785c"/>
          </linearGradient>
        </defs>
        <!-- The actual mark (also used as the header's "◈" glyph and in
             icons/icon48.png): an outlined diamond containing a smaller
             solid one, not a single rotated square. -->
        <polygon points="50,8 92,50 50,92 8,50" fill="none" stroke="#cc785c" stroke-width="5"/>
        <polygon points="50,24 76,50 50,76 24,50" fill="url(#cly-mini-grad)"/>
      </svg>
      <span id="cly-mini-dot"></span>
    </button>
  `;
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);

  // The mini logo is an inline <svg>, not an <img> pointing at icons/icon48.png.
  // claude.ai's Content-Security-Policy is `img-src 'self' …` with no
  // chrome-extension: (or data:) source, and that policy governs images a
  // content script injects into the page — so an extension-hosted <img> is
  // blocked no matter what, even when it's web-accessible. Inline SVG is a DOM
  // node, not a resource load, so img-src never applies and it always renders.

  const header  = $('cly-header');
  const miniBtn = $('cly-mini-btn');
  const peakEl  = $('cly-peak-banner');

  // ── Geometry ───────────────────────────────────────────────────────────

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // Positions the panel by its right/top gap, clamped so it can never end up
  // outside the viewport. Callers that already know the panel's size pass it
  // in — a move gesture doesn't change it, so re-measuring on every pointer
  // event would force a layout for nothing.
  function place(right, top, w, h) {
    // A hidden or still-loading document measures 0×0. Clamping against that
    // would collapse the panel into the corner and persist it there, so leave
    // the position alone until there is a real viewport to clamp against.
    if (!window.innerWidth || !window.innerHeight) return;
    if (w === undefined) ({ width: w, height: h } = root.getBoundingClientRect());
    root.style.right  = `${clamp(right, 0, Math.max(0, window.innerWidth  - w))}px`;
    root.style.top    = `${clamp(top,   0, Math.max(0, window.innerHeight - h))}px`;
    root.style.bottom = 'auto';
  }

  function savePos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ right: root.style.right, top: root.style.top }));
    } catch {}
  }

  function applyDefaultWidth() {
    root.style.width = `${defaultWidth}px`;
    root.style.height = '';
  }
  applyDefaultWidth();

  // ── Restore saved position (size is intentionally not persisted) ───────

  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved) {
      if (saved.top)   root.style.top   = saved.top;
      if (saved.right) root.style.right = saved.right;
    }
  } catch {}

  // Pull the panel back inside the viewport at its current size and position.
  function reclamp() {
    if (gesture) return;
    const r = root.getBoundingClientRect();
    place(window.innerWidth - r.right, r.top, r.width, r.height);
  }

  // Re-clamp whenever the panel's own size changes, so it can never end up
  // hanging off an edge. Three things make this necessary and none of them can
  // be handled at restore time: the height depends on limit rows that arrive
  // asynchronously, minimizing swaps the panel for a 34px square, and a
  // position saved in a larger window is restored into a smaller one.
  new ResizeObserver(reclamp).observe(root);

  // A background tab lays out at 0×0, so any of the above that happens while
  // the user is on another tab reaches place() with nothing to clamp against
  // and is skipped. Catch up the moment the tab is actually looked at.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reclamp();
  });

  chrome.storage.local.get(PANEL_SIZE_KEY, (r) => {
    const pref = r[PANEL_SIZE_KEY];
    if (pref && PANEL_WIDTHS[pref]) {
      defaultWidth = PANEL_WIDTHS[pref];
      if (!mini && !gesture) applyDefaultWidth();
    }
  });

  // ── Minimize / expand (whole panel becomes a small square button) ──────

  function setMini(next) {
    mini = next;
    root.classList.toggle('cly-mini', mini);
    // Reset to the default size every time the panel is (re)opened. The
    // ResizeObserver above re-clamps the position against the new size.
    if (!mini) applyDefaultWidth();
  }

  $('cly-collapse').addEventListener('click', () => setMini(true));
  // Expanding from mini is a tap on the square, handled in endGesture below —
  // the same press can also start a drag, so it can't be a plain click listener.

  // ── Drag & resize — one pointer-driven gesture system ──────────────────
  // Pointer Events with setPointerCapture, rather than mouse events bound to
  // document. The capture buys three things the old code got wrong:
  //   • a release outside the window still delivers pointerup, so the panel
  //     can never get stuck following the cursor with no button held;
  //   • touch and pen drag the panel with no separate code path;
  //   • move/up retarget to the captured element and bubble to #clautics-root,
  //     so three listeners on the panel replace four on document.

  const DRAG_THRESHOLD = 4; // px of travel before a press counts as a drag

  function beginGesture(e, edge) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = root.getBoundingClientRect();
    gesture = {
      edge,                                    // null = move, otherwise resize
      el: e.currentTarget,
      id: e.pointerId,
      x: e.clientX, y: e.clientY,
      w: rect.width, h: rect.height,
      top: rect.top,
      right: window.innerWidth - rect.right,
      moved: false,
    };
    // Capture is what keeps the gesture alive outside the window; if the
    // browser refuses it, still drag — just without that guarantee.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    root.classList.add(edge ? 'cly-resizing' : 'cly-dragging');
    e.preventDefault();
    e.stopPropagation();
  }

  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cly-hd-btn')) return;
    beginGesture(e, null);
  });
  miniBtn.addEventListener('pointerdown', (e) => beginGesture(e, null));

  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = `cly-resize-handle cly-resize-${edge}`;
    handle.addEventListener('pointerdown', (e) => { if (!mini) beginGesture(e, edge); });
    root.appendChild(handle);
  }

  root.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const { edge, w, h, top, right } = gesture;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) gesture.moved = true;

    if (!edge) { place(right - dx, top + dy, w, h); return; }

    if (edge.includes('e')) {
      const nw = clamp(w + dx, MIN_W, MAX_W);
      root.style.width = `${nw}px`;
      root.style.right = `${right - (nw - w)}px`;
    } else if (edge.includes('w')) {
      root.style.width = `${clamp(w - dx, MIN_W, MAX_W)}px`;
      root.style.right = `${right}px`;
    }

    if (edge.includes('s')) {
      root.style.height = `${clamp(h + dy, MIN_H, MAX_H)}px`;
      root.style.top    = `${top}px`;
    } else if (edge.includes('n')) {
      const nh = clamp(h - dy, MIN_H, MAX_H);
      root.style.height = `${nh}px`;
      root.style.top    = `${top + h - nh}px`;
    }
  });

  // Never leave dead space: if the panel was stretched taller than its content
  // actually needs, snap the height back down to fit instead of keeping a
  // mostly-empty box. Shrinking below content height is fine — the body just
  // scrolls (see #cly-body { overflow-y: auto }).
  //
  // #cly-body is flex:1 with overflow-y:auto, so its scrollHeight can't be read
  // while root is still forced to the dragged (possibly oversized) height — an
  // auto-overflow element's scrollHeight is never smaller than its own current
  // clientHeight, which would just echo the dragged size back. Temporarily go
  // auto to get a clean natural-size measurement.
  function snapHeight(edge) {
    if (!edge.includes('n') && !edge.includes('s')) return;
    const draggedHeight = root.style.height;
    const { bottom: draggedBottom, height: draggedBoxHeight } = root.getBoundingClientRect();

    root.style.height = '';
    const naturalBoxHeight = root.getBoundingClientRect().height;

    if (draggedBoxHeight > naturalBoxHeight + 0.5) {
      // Natural content is shorter than what was dragged — stay auto, and keep
      // the bottom edge anchored if that's the edge the user was moving.
      if (edge.includes('n')) root.style.top = `${draggedBottom - naturalBoxHeight}px`;
    } else {
      // Deliberately shrunk below content height — keep it, the body scrolls.
      root.style.height = draggedHeight;
    }
  }

  function endGesture(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const { edge, moved, el, id } = gesture;
    gesture = null;
    if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    root.classList.remove('cly-resizing', 'cly-dragging');

    if (edge) snapHeight(edge);
    else if (mini && !moved) setMini(false); // a tap on the square reopens it
    savePos();
  }

  root.addEventListener('pointerup', endGesture);
  root.addEventListener('pointercancel', endGesture);

  // Shrinking the window must not strand the panel outside it.
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; reclamp(); });
  });

  // ── Render limits ─────────────────────────────────────────────────────

  let currentLimits = {};

  function renderLimits(limits) {
    currentLimits = limits || {};
    const container = $('cly-limits');
    const entries = CLY.ORDER
      .map((key) => [key, currentLimits[key]])
      .filter(([, v]) => v != null);

    if (!entries.length) {
      // Built as DOM nodes rather than an innerHTML string — chrome.i18n text
      // is appended as text nodes this way, so it can never be parsed as markup.
      const empty = document.createElement('div');
      empty.className = 'cly-empty';
      empty.append(
        chrome.i18n.getMessage('panelNoLimitsFound'),
        document.createElement('br'),
        chrome.i18n.getMessage('panelOpenConversation')
      );
      container.replaceChildren(empty);
      renderMiniDot();
      return;
    }

    // Build off-document, then swap in once — one layout pass instead of one
    // per row, on a path that reruns after every completion on claude.ai.
    const frag = document.createDocumentFragment();
    for (const [key, limit] of entries) {
      const pct   = limit.pct ?? 0;
      const color = `var(--cly-${CLY.level(pct)})`;

      const row = document.createElement('div'); row.className = 'cly-limit-row';
      const top = document.createElement('div'); top.className = 'cly-limit-top';
      const label = document.createElement('span'); label.className = 'cly-limit-label';
      label.textContent = CLY.LABELS[key] || key;
      const pctEl = document.createElement('span'); pctEl.className = 'cly-limit-pct';
      pctEl.style.color = color; pctEl.textContent = `${pct.toFixed(0)}%`;
      top.append(label, pctEl);

      const track = document.createElement('div'); track.className = 'cly-track';
      const fill  = document.createElement('div'); fill.className = 'cly-fill';
      fill.style.width = `${Math.min(pct, 100)}%`; fill.style.background = color;
      track.appendChild(fill);

      const meta = document.createElement('div'); meta.className = 'cly-limit-meta';
      if (key === 'extraUsage' && limit.usedCents != null) {
        meta.textContent = `$${(limit.usedCents / 100).toFixed(2)} / $${(limit.limitCents / 100).toFixed(2)}`;
      } else if (limit.resetsAt) {
        const resetLabel = document.createElement('span');
        resetLabel.className = 'cly-reset-label';
        resetLabel.dataset.ts = limit.resetsAt;
        resetLabel.textContent = `↺ ${CLY.countdown(limit.resetsAt)}`;
        meta.appendChild(resetLabel);
      }

      row.append(top, track, meta);
      frag.appendChild(row);
    }
    container.replaceChildren(frag);
    renderMiniDot();
  }

  // ── Mini dot (warns on the minimized icon once usage is actually high) ──
  // Hidden below 80% — showing it at every percentage made the minimized
  // icon look like it permanently had a notification badge glued to it.

  function renderMiniDot() {
    let topPct = 0;
    for (const v of Object.values(currentLimits)) {
      if (v && typeof v.pct === 'number' && v.pct > topPct) topPct = v.pct;
    }
    const level = CLY.level(topPct);
    const show  = level !== 'accent';
    const dot   = $('cly-mini-dot');
    dot.classList.toggle('cly-dot-visible', show);
    if (show) dot.style.backgroundColor = `var(--cly-${level})`;
  }

  // ── Footer ────────────────────────────────────────────────────────────

  function renderFooter(state) {
    const tierEl = $('cly-tier-badge');
    tierEl.textContent   = CLY.TIERS[state.tier] || '';
    tierEl.style.display = tierEl.textContent ? 'inline-block' : 'none';
    if (state.fetchedAt) {
      const ago = Math.round((Date.now() - state.fetchedAt) / 1000);
      $('cly-updated').textContent = ago < 10
        ? chrome.i18n.getMessage('justNow')
        : chrome.i18n.getMessage('agoSeconds', [String(ago)]);
    }
  }

  // ── State ─────────────────────────────────────────────────────────────

  let lastState = null;

  function applyState(state) {
    if (!state) return;
    lastState = state;
    if (state.limits) renderLimits(state.limits);
    CLY.renderPeak(peakEl, state.heatmap, 'cly-peak-visible');
    renderFooter(state);
  }

  // ── Countdowns ────────────────────────────────────────────────────────

  CLY.interval(() => {
    // Nothing here is visible while minimized, so don't touch the DOM at all.
    if (mini) return;
    for (const el of root.querySelectorAll('[data-ts]')) {
      el.textContent = `↺ ${CLY.countdown(Number(el.dataset.ts))}`;
    }
    if (lastState) renderFooter(lastState);
  }, 20_000);

  // ── Theme ─────────────────────────────────────────────────────────────

  const THEME_KEY = 'clautics_theme';

  function applyPanelTheme(theme) {
    root.setAttribute('data-theme', theme);
    root.style.backgroundColor = theme === 'light' ? '#f9f9f8' : '#1e1e1e';
    $('cly-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  chrome.storage.local.get(THEME_KEY, (r) => applyPanelTheme(r[THEME_KEY] || 'dark'));

  $('cly-theme').addEventListener('click', () => {
    const next = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
    applyPanelTheme(next);
    chrome.storage.local.set({ [THEME_KEY]: next });
    chrome.runtime.sendMessage({ type: 'clautics_theme', theme: next }).catch(() => {});
  });

  // ── Init ──────────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'clautics_get' }, applyState);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'clautics_theme')  applyPanelTheme(msg.theme);
    if (msg.type === 'clautics_update') applyState(msg.data);
    if (msg.type === 'clautics_panel_size' && PANEL_WIDTHS[msg.size]) {
      defaultWidth = PANEL_WIDTHS[msg.size];
      if (!mini && !gesture) applyDefaultWidth();
    }
  });

})();
