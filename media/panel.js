(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  let selected = saved.selected || 'editor';
  let channel = saved.channel === 'fg' ? 'fg' : 'bg';
  let state = null;
  let defs = new Map();

  // Edits made in this panel win over incoming state for a short while, so a drag is
  // never pulled back by a settings round-trip that has not caught up yet.
  const HOLD_MS = 1500;
  const local = new Map();

  let hsv = { h: 0, s: 0, v: 0 };
  let dragging = false;

  const SWATCHES = [
    '#1e1e1e', '#252526', '#2d2d30', '#3c3c3c', '#5a5a5a', '#9e9e9e', '#d4d4d4', '#f3f3f3', '#ffffff',
    '#0e639c', '#007acc', '#00838f', '#16825d', '#2e7d32', '#6a1b9a', '#ad1457', '#c62828', '#e65100',
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    scopeButtons: Array.from(document.querySelectorAll('[data-scope]')),
    scopeHint: $('scopeHint'),
    regions: Array.from(document.querySelectorAll('[data-block]')),
    blockName: $('blockName'),
    resetBlock: $('resetBlock'),
    source: $('source'),
    warn: $('warn'),
    channelButtons: Array.from(document.querySelectorAll('[data-ch]')),
    sv: $('sv'),
    svThumb: $('svThumb'),
    hue: $('hue'),
    hueThumb: $('hueThumb'),
    chip: $('chip'),
    hex: $('hex'),
    auto: $('auto'),
    resetCh: $('resetCh'),
    swatches: $('swatches'),
    contrast: $('contrast'),
    resetAll: $('resetAll'),
  };

  window.addEventListener('error', (e) => {
    vscode.postMessage({ type: 'error', message: String(e.message || e) });
  });

  // ---- color math ----

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function parseColor(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (s[0] === '#') {
      let h = s.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channelValue = (x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x));
    const alpha = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    const c = { r: channelValue(parts[0]), g: channelValue(parts[1]), b: channelValue(parts[2]), a: alpha };
    return [c.r, c.g, c.b, c.a].some(Number.isNaN) ? null : c;
  }

  function toHex(c) {
    return '#' + [c.r, c.g, c.b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  }

  function rgbToHsv(c) {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsvToRgb({ h, s, v }) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
  }

  function luminance(c) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // ---- current colors ----

  function cssVar(key) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--vscode-' + key.replace(/\./g, '-'))
      .trim();
  }

  // Color the active theme gives this block right now (includes any customizations).
  function themeHex(blockId, ch) {
    const def = defs.get(blockId);
    for (const key of def ? def[ch] : []) {
      const c = parseColor(cssVar(key));
      if (c && c.a > 0.05) return toHex(c);
    }
    const fallback = parseColor(cssVar(ch === 'bg' ? 'editor.background' : 'foreground'));
    if (fallback) return toHex(fallback);
    return ch === 'bg' ? '#1e1e1e' : '#cccccc';
  }

  function current(blockId, ch) {
    const held = local.get(blockId + '.' + ch);
    if (held && Date.now() - held.t < HOLD_MS) return { hex: held.value, source: 'local' };
    const info = state && state.blocks[blockId] && state.blocks[blockId][ch];
    if (info && info.value && parseColor(info.value)) return { hex: info.value, source: 'own' };
    if (info && info.inherited && parseColor(info.inherited)) return { hex: info.inherited, source: 'inherited' };
    return { hex: themeHex(blockId, ch), source: 'theme' };
  }

  // ---- sending edits ----

  const SEND_MS = 90;
  const outbox = new Map();
  let sendTimer = null;
  let lastSend = 0;

  function queueSend(block, ch, value) {
    outbox.set(block + '.' + ch, { block, channel: ch, value });
    const wait = SEND_MS - (Date.now() - lastSend);
    if (wait <= 0) flushSend();
    else if (!sendTimer) sendTimer = setTimeout(flushSend, wait);
  }

  function flushSend() {
    if (sendTimer) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    lastSend = Date.now();
    for (const m of outbox.values()) vscode.postMessage({ type: 'setColor', block: m.block, channel: m.channel, value: m.value });
    outbox.clear();
  }

  function applyColor(hex) {
    local.set(selected + '.' + channel, { value: hex, t: Date.now() });
    queueSend(selected, channel, hex);
    render();
  }

  function clearLocal(block, ch) {
    local.delete(block + '.' + ch);
    outbox.delete(block + '.' + ch);
  }

  // ---- rendering ----

  function render() {
    if (!state) return;
    renderScope();
    renderWindow();
    renderCard();
  }

  function renderScope() {
    for (const b of els.scopeButtons) {
      b.setAttribute('aria-checked', String(b.dataset.scope === state.scope));
      if (b.dataset.scope === 'workspace') {
        b.disabled = !state.hasWorkspace;
        b.title = state.hasWorkspace
          ? 'Save colors only for ' + (state.workspaceName || 'this workspace')
          : 'Open a folder to save colors per project';
      } else {
        b.title = 'Save colors in your user settings';
      }
    }
    els.scopeHint.textContent = state.scope === 'workspace'
      ? 'Saved to the workspace settings of "' + (state.workspaceName || 'this workspace') + '". Other windows keep their own colors.'
      : 'Saved to your user settings, so every window uses these colors.';
  }

  function renderWindow() {
    for (const el of els.regions) {
      const id = el.dataset.block;
      const def = defs.get(id);
      el.style.background = current(id, 'bg').hex;
      el.style.color = current(id, 'fg').hex;
      el.classList.toggle('sel', id === selected);
      el.setAttribute('aria-pressed', String(id === selected));
      el.title = def ? def.label : id;
    }
  }

  function renderCard() {
    const def = defs.get(selected);
    const blockState = state.blocks[selected];
    const info = blockState[channel];
    const cur = current(selected, channel);

    els.blockName.textContent = def ? def.label : selected;

    const where = state.scope === 'workspace' ? 'workspace settings' : 'user settings';
    if (info.value || cur.source === 'local') els.source.textContent = 'Custom color, saved in ' + where + '.';
    else if (info.inherited) els.source.textContent = 'Inherited from your user settings. Pick a color to override it for this workspace.';
    else els.source.textContent = 'Using the color theme default.';

    const overridden = blockState.bg.overridden || blockState.fg.overridden;
    els.warn.hidden = !overridden;
    if (overridden) {
      els.warn.textContent = 'This workspace has its own colors for this block, so user-level changes will not show in this window.';
    }

    for (const b of els.channelButtons) b.setAttribute('aria-selected', String(b.dataset.ch === channel));
    els.auto.hidden = channel !== 'fg';
    els.resetCh.disabled = !(info.value || cur.source === 'local');

    if (!dragging) syncPicker(cur.hex);
    paintPicker();

    if (document.activeElement !== els.hex) {
      els.hex.value = cur.hex.toUpperCase();
      els.hex.classList.remove('bad');
    }
    els.chip.style.background = cur.hex;

    const bg = parseColor(current(selected, 'bg').hex);
    const fg = parseColor(current(selected, 'fg').hex);
    if (bg && fg) {
      const ratio = contrast(bg, fg);
      const verdict = ratio >= 4.5 ? 'easy to read' : ratio >= 3 ? 'readable for large text only' : 'hard to read';
      els.contrast.textContent = 'Text contrast ' + ratio.toFixed(1) + ':1, ' + verdict + '.';
    }
  }

  function syncPicker(hex) {
    const c = parseColor(hex);
    if (!c) return;
    if (toHex(hsvToRgb(hsv)) === toHex(c)) return;
    const next = rgbToHsv(c);
    // Grays and black carry no hue; keep the slider where the user left it.
    if (next.s === 0 || next.v === 0) next.h = hsv.h;
    hsv = next;
  }

  function paintPicker() {
    els.sv.style.backgroundColor = toHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
    els.svThumb.style.left = hsv.s * 100 + '%';
    els.svThumb.style.top = (1 - hsv.v) * 100 + '%';
    els.hueThumb.style.left = (hsv.h / 360) * 100 + '%';
  }

  // A timer rather than requestAnimationFrame: frames are paused while the view is hidden,
  // and theme updates that land then should still be picked up.
  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, 16);
  }

  function saveViewState() {
    vscode.setState({ selected, channel });
  }

  // ---- picker input ----

  function pickerChanged() {
    applyColor(toHex(hsvToRgb(hsv)));
  }

  let dragEl = null;

  function bindDrag(el, onPoint) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus();
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {
        // Capture is a nicety; dragging still works inside the element without it.
      }
      dragging = true;
      dragEl = el;
      onPoint(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (dragEl === el) onPoint(e);
    });
    const end = (e) => {
      if (dragEl !== el) return;
      dragging = false;
      dragEl = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      flushSend();
      render();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  bindDrag(els.sv, (e) => {
    const r = els.sv.getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    pickerChanged();
  });

  bindDrag(els.hue, (e) => {
    const r = els.hue.getBoundingClientRect();
    hsv.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    pickerChanged();
  });

  els.sv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    hsv.s = clamp(hsv.s + move[0], 0, 1);
    hsv.v = clamp(hsv.v + move[1], 0, 1);
    pickerChanged();
  });

  els.hue.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 2;
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    hsv.h = clamp(hsv.h + delta, 0, 360);
    pickerChanged();
  });

  function parseHexInput(raw, allowShort) {
    let h = raw.trim().replace(/^#/, '');
    if (allowShort && h.length === 3) h = h.split('').map((c) => c + c).join('');
    return /^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h) ? '#' + h.toLowerCase() : null;
  }

  els.hex.addEventListener('input', () => {
    const value = parseHexInput(els.hex.value, false);
    if (!value) return;
    els.hex.classList.remove('bad');
    applyColor(value);
  });

  els.hex.addEventListener('change', () => {
    const value = parseHexInput(els.hex.value, true);
    if (!value) {
      els.hex.classList.add('bad');
      return;
    }
    els.hex.classList.remove('bad');
    applyColor(value);
    flushSend();
  });

  els.hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      els.hex.blur();
    } else if (e.key === 'Escape') {
      els.hex.value = current(selected, channel).hex.toUpperCase();
      els.hex.classList.remove('bad');
      els.hex.blur();
    }
  });

  els.hex.addEventListener('blur', () => render());

  // ---- buttons ----

  for (const el of els.regions) {
    el.addEventListener('click', () => {
      selected = el.dataset.block;
      saveViewState();
      render();
    });
  }

  for (const b of els.channelButtons) {
    b.addEventListener('click', () => {
      channel = b.dataset.ch;
      saveViewState();
      render();
    });
  }

  for (const b of els.scopeButtons) {
    b.addEventListener('click', () => {
      if (b.disabled || (state && state.scope === b.dataset.scope)) return;
      flushSend();
      vscode.postMessage({ type: 'setScope', scope: b.dataset.scope });
    });
  }

  for (const hex of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = hex;
    b.title = hex.toUpperCase();
    b.setAttribute('aria-label', 'Use ' + hex.toUpperCase());
    b.addEventListener('click', () => {
      applyColor(hex);
      flushSend();
    });
    els.swatches.appendChild(b);
  }

  els.auto.addEventListener('click', () => {
    const bg = parseColor(current(selected, 'bg').hex);
    if (!bg) return;
    const light = { r: 255, g: 255, b: 255 };
    const dark = { r: 30, g: 30, b: 30 };
    applyColor(contrast(bg, light) >= contrast(bg, dark) ? '#ffffff' : '#1e1e1e');
    flushSend();
  });

  els.resetCh.addEventListener('click', () => {
    clearLocal(selected, channel);
    vscode.postMessage({ type: 'setColor', block: selected, channel, value: null });
  });

  els.resetBlock.addEventListener('click', () => {
    clearLocal(selected, 'bg');
    clearLocal(selected, 'fg');
    vscode.postMessage({ type: 'resetBlock', block: selected });
  });

  els.resetAll.addEventListener('click', () => {
    flushSend();
    vscode.postMessage({ type: 'resetAll' });
  });

  // ---- messages from the extension ----

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      if (state && state.scope !== msg.scope) local.clear();
      state = msg;
      defs = new Map(msg.definitions.map((d) => [d.id, d]));
      if (!defs.has(selected)) selected = msg.definitions[0].id;
      // Drop held edits the saved settings have caught up with.
      for (const [key, held] of local) {
        const [block, ch] = key.split('.');
        const info = msg.blocks[block] && msg.blocks[block][ch];
        if (info && info.value && info.value.toLowerCase() === held.value.toLowerCase()) local.delete(key);
      }
      render();
    } else if (msg.type === 'theme') {
      scheduleRender();
    }
  });

  // Theme colors arrive as CSS variables on <html>; re-read them whenever they change.
  new MutationObserver(scheduleRender).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  new MutationObserver(scheduleRender).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  vscode.postMessage({ type: 'ready' });
})();
