/* مشترك بين شاشة المضيف وصفحة اللاعب */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let clockOffset = 0; // فرق توقيت الخادم
function syncClock(st) { if (st.serverNow) clockOffset = st.serverNow - Date.now(); }
const serverNow = () => Date.now() + clockOffset;

/* مؤقت تنازلي يحدّث شريطاً ورقماً */
function makeCountdown(barEl, numEl) {
  let raf = null, deadline = 0, total = 1;
  function tick() {
    const left = Math.max(0, deadline - serverNow());
    if (barEl) barEl.style.width = (100 * left / total) + '%';
    if (numEl) numEl.textContent = Math.ceil(left / 1000);
    if (barEl) barEl.classList.toggle('urgent', left < 5000 && left > 0);
    if (left > 0) raf = requestAnimationFrame(tick); else raf = null;
  }
  return {
    set(dl, seconds) { deadline = dl; total = Math.max(1, seconds * 1000); cancelAnimationFrame(raf); if (dl) tick(); else { if (barEl) barEl.style.width = '0%'; if (numEl) numEl.textContent = ''; } },
  };
}

/* ---------- الخريطة ---------- */
let WORLD = null;
async function loadWorld() { if (!WORLD) WORLD = await (await fetch('/world.json')).json(); return WORLD; }

function buildMap(svg, { interactive = false, onTap = null } = {}) {
  const W = WORLD.width, H = WORLD.height;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<rect class="sea" x="0" y="0" width="${W}" height="${H}"/>
    <g class="land">${WORLD.countries.map(c => `<path data-id="${c.id}" d="${c.d}"/>`).join('')}</g>
    <g class="overlay"></g>`;
  const view = { x: 0, y: 0, w: W, h: H };
  const apply = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const toSvg = (cx, cy) => { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: p.y }; };
  function zoomAt(cx, cy, factor) {
    const p = toSvg(cx, cy);
    const nw = Math.min(W, Math.max(W / 12, view.w / factor)); const nh = nw * H / W;
    view.x = p.x - (p.x - view.x) * nw / view.w; view.y = p.y - (p.y - view.y) * nh / view.h;
    view.w = nw; view.h = nh; clamp(); apply();
  }
  function clamp() { view.x = Math.max(0, Math.min(W - view.w, view.x)); view.y = Math.max(0, Math.min(H - view.h, view.y)); }
  function reset() { view.x = 0; view.y = 0; view.w = W; view.h = H; apply(); }

  if (interactive) {
    const ptrs = new Map(); let moved = false, start = null, pinchDist = 0;
    svg.style.touchAction = 'none';
    svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); } });
    svg.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinchDist) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist); pinchDist = d; moved = true; return; }
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 6) moved = true;
      if (moved) { const r = svg.getBoundingClientRect(); const k = view.w / r.width; view.x = start.vx - dx * k; view.y = start.vy - dy * k; clamp(); apply(); }
    });
    const up = e => { if (ptrs.size === 1 && !moved && onTap) { const p = toSvg(e.clientX, e.clientY); onTap(p); } ptrs.delete(e.pointerId); pinchDist = 0; };
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', e => ptrs.delete(e.pointerId));
    svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
  }
  const overlay = svg.querySelector('.overlay');
  return {
    svg, overlay, reset, zoomAt, view,
    zoomIn() { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.5); },
    zoomOut() { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.5); },
    highlight(id) { $$('.land path', svg).forEach(p => p.classList.toggle('hit', p.dataset.id === id)); },
    clear() { overlay.innerHTML = ''; },
    pin(x, y, { label = '', cls = '', r = 7 } = {}) {
      const k = view.w / W; // لتثبيت حجم الدبوس عند التكبير
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'pin ' + cls); g.setAttribute('transform', `translate(${x},${y})`);
      g.innerHTML = `<circle r="${r * k}" /><circle r="${2 * k}" class="dot"/>` + (label ? `<text y="${-(r + 4) * k}" style="font-size:${13 * k}px">${esc(label)}</text>` : '');
      overlay.appendChild(g); return g;
    },
    target(x, y) {
      const k = view.w / W;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'target'); g.setAttribute('transform', `translate(${x},${y})`);
      g.innerHTML = `<circle r="${14 * k}" class="ring"/><circle r="${4 * k}" class="core"/>`;
      overlay.appendChild(g); return g;
    },
    line(x1, y1, x2, y2) { const l = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2); l.setAttribute('class', 'dist'); l.setAttribute('stroke-width', 1.2 * view.w / W); overlay.appendChild(l); },
  };
}

/* ---------- أصوات بسيطة ---------- */
const Sfx = (() => {
  let ctx = null;
  const ac = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; } catch { return null; } };
  function tone(f, dur = 0.15, type = 'sine', gain = 0.25, when = 0) {
    const c = ac(); if (!c) return; const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = gain; o.connect(g); g.connect(c.destination);
    const t = c.currentTime + when; o.start(t); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.stop(t + dur + 0.05);
  }
  return {
    unlock() { ac(); },
    buzz() { tone(880, 0.12, 'square', 0.2); tone(1320, 0.18, 'square', 0.2, 0.1); },
    good() { tone(523, 0.12, 'triangle'); tone(659, 0.12, 'triangle', 0.25, 0.12); tone(784, 0.25, 'triangle', 0.25, 0.24); },
    bad() { tone(220, 0.25, 'sawtooth', 0.2); tone(180, 0.35, 'sawtooth', 0.2, 0.2); },
    tick() { tone(1000, 0.05, 'sine', 0.08); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.25, i * 0.15)); },
  };
})();

const ROUND_ICON = { flag: '🚩', map: '🗺️', auction: '💰' };
const fmt = n => (n > 0 ? '+' : '') + n;
