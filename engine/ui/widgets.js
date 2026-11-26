// Reusable TV + phone widgets. All player-supplied text goes through text nodes.
import { h, s } from './dom.js';
import { sheet } from './overlay.js';

// ---------- Buttons ----------
// Big action button whose disabled state explains why.
export function actionButton(label, { onClick, reason = null, kind = 'primary', big = false, sub = null, cls = '' } = {}) {
  const disabled = !!reason;
  const b = h('button.btn.' + kind + (big ? '.big' : '') + (cls ? '.' + cls : ''), {
    disabled, 'aria-disabled': disabled ? 'true' : null,
    onclick: async (e) => {
      if (disabled || b.dataset.busy) return;
      b.dataset.busy = '1'; b.classList.add('busy');
      try { await onClick?.(e); } finally { delete b.dataset.busy; b.classList.remove('busy'); }
    },
  }, h('span.btn-label', null, label), (reason || sub) ? h('span.btn-sub', null, reason || sub) : null);
  return b;
}

// ---------- Status ----------
export function phasePill(text, kind = '') {
  return h('span.pill' + (kind ? '.' + kind : ''), null, text);
}

export function onlineDot(on) {
  return h('span.dot-online' + (on ? '.on' : ''), { title: on ? 'Online' : 'Offline', 'aria-label': on ? 'online' : 'offline' });
}

export function joinChip(code) {
  return h('div.join-chip', null, 'Join with code ', h('b', null, code));
}

export function connBadge(status) {
  const map = { online: ['Live', 'ok'], local: ['Local test', 'local'], connecting: ['Connecting…', 'warn'], offline: ['Offline', 'bad'] };
  const [t, k] = map[status] || [status, ''];
  return h('span.conn.' + k, null, t);
}

// rows: [{pid, name, on, active, leader, tags:[...], status, score, extra: Node}]
export function scoreboard(rows, { compact = false, mePid = null } = {}) {
  return h('ol.scoreboard' + (compact ? '.compact' : ''), null, rows.map((r) =>
    h('li.sb-row' + (r.active ? '.active' : '') + (r.pid === mePid ? '.me' : '') + (r.dim ? '.dim' : ''), null,
      onlineDot(r.on),
      h('span.sb-name', null, r.name,
        r.leader ? h('span.tag.leader', null, 'Leader') : null,
        (r.tags || []).map((t) => h('span.tag' + (t.kind ? '.' + t.kind : ''), null, t.text || t))),
      r.status != null ? h('span.sb-status', null, r.status) : null,
      r.score != null ? h('span.sb-score', null, String(r.score)) : null,
      r.extra || null)));
}

export function historyStrip(log) {
  return h('div.history', { 'aria-label': 'History' },
    (log || []).slice(-10).reverse().map((e, i) => h('span.hist-item' + (i === 0 ? '.latest' : ''), null, e.t)));
}

export function waiting(text, { ready, total } = {}) {
  return h('div.waiting', null,
    h('div.spinner', { 'aria-hidden': 'true' }),
    h('div', null, text),
    total ? h('div.waiting-count', null, `${ready} of ${total} ready`) : null);
}

export function spectatorBanner(text = "You're watching this game") {
  return h('div.spectator-banner', null, '👀 ', text);
}

// ---------- Cards ----------
// Horizontally scrollable hand with selection constraints.
// opts: { cards:[{id,...}], render(card)=>Node, mode:'none'|'single'|'multi', min, max,
//         store: object kept across re-renders (selection lives in store.sel), onChange(ids) }
export function hand({ cards, render, mode = 'single', min = 1, max = mode === 'single' ? 1 : Infinity, store = {}, onChange, disabled = false }) {
  const valid = new Set(cards.map((c) => c.id));
  store.sel = (store.sel || []).filter((id) => valid.has(id));
  const el = h('div.hand' + (mode === 'none' ? '.static' : ''), { role: mode === 'none' ? null : 'listbox', 'aria-multiselectable': mode === 'multi' ? 'true' : null });
  const paint = () => [...el.children].forEach((c) => {
    const on = store.sel.includes(c.dataset.id);
    c.classList.toggle('selected', on);
    c.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  for (const card of cards) {
    const c = h('button.hand-card', { dataset: { id: card.id }, role: 'option', disabled: disabled || mode === 'none' }, render(card));
    c.addEventListener('click', () => {
      if (mode === 'none' || disabled) return;
      const has = store.sel.includes(card.id);
      if (mode === 'single') store.sel = has ? [] : [card.id];
      else if (has) store.sel = store.sel.filter((x) => x !== card.id);
      else if (store.sel.length < max) store.sel = [...store.sel, card.id];
      paint();
      onChange && onChange(store.sel.slice(), store.sel.length >= min && store.sel.length <= max);
    });
    el.append(c);
  }
  paint();
  return { el, selected: () => store.sel.slice(), ok: () => store.sel.length >= min && store.sel.length <= max };
}

// A choice sheet: "play to expedition / discard", "keep these tickets".
// choices: [{label, sub, value, reason, kind}]  → resolves to value or null.
export function choiceSheet({ title, body, choices }) {
  return new Promise((res) => {
    let done = false;
    sheet((close) => h('div.choices', null,
      body ? h('p', null, body) : null,
      choices.map((c) => actionButton(c.label, {
        kind: c.kind || 'secondary', sub: c.sub, reason: c.reason,
        onClick: () => { done = true; res(c.value); close(); },
      }))), { title, onClose: () => { if (!done) res(null); } });
  });
}

// Market picker: tap a face-up item on a mirrored mini view.
// items: [{id, node: Node, reason?}]  onPick(id)
export function marketPicker(items, { onPick, cols = 4, selected = null } = {}) {
  return h('div.market', { style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } }, items.map((it) =>
    h('button.market-item' + (selected === it.id ? '.selected' : ''), {
      disabled: !!it.reason, title: it.reason || '', onclick: () => onPick && onPick(it.id),
    }, it.node)));
}

// ---------- Board surface ----------
// Responsive SVG stage that keeps its aspect ratio and fills the remaining space.
export function board({ width = 1600, height = 900, pannable = false, cls = '' } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', class: 'board-svg', role: 'img' });
  const el = h('div.board' + (cls ? '.' + cls : ''), null, svg);
  if (pannable) {
    let vb = { x: 0, y: 0, w: width, h: height }, drag = null;
    const set = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaY > 0 ? 1.1 : 0.9;
      const nw = Math.min(width, Math.max(width / 6, vb.w * k)), nh = nw * height / width;
      vb.x += (vb.w - nw) / 2; vb.y += (vb.h - nh) / 2; vb.w = nw; vb.h = nh; set();
    }, { passive: false });
    svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect(), k = vb.w / r.width;
      vb.x -= (e.clientX - drag.x) * k; vb.y -= (e.clientY - drag.y) * k; drag = { x: e.clientX, y: e.clientY }; set();
    });
    svg.addEventListener('pointerup', () => { drag = null; });
  }
  return { el, svg };
}

// ---------- Results ----------
export function winnerLine(results, nameOf) {
  if (results?.headline) return results.headline;
  const top = (results?.ranking || []).filter((r) => r.rank === 1);
  if (!top.length) return 'Game over!';
  if (top.length > 1) return `Tie: ${top.map((t) => nameOf(t.pid)).join(' & ')}!`;
  return `${nameOf(top[0].pid)} wins!`;
}

// results: { ranking:[{pid, rank, score, detail:{colId: value}}], columns:[{id,label}], headline }
export function podium(results, nameOf) {
  const r = results?.ranking || [];
  const top = r.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  return h('div.podium-wrap', null,
    h('div.podium', null, order.map((p) => h('div.step.rank' + Math.min(p.rank, 3), null,
      h('div.step-name', null, nameOf(p.pid)),
      h('div.step-score', null, String(p.score)),
      h('div.step-block', null, ['', '1st', '2nd', '3rd'][Math.min(p.rank, 3)] || p.rank + 'th')))),
    resultsTable(results, nameOf));
}

export function resultsTable(results, nameOf) {
  const cols = results?.columns || [];
  return h('table.results', null,
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), cols.map((c) => h('th', null, c.label)), h('th', null, 'Total'))),
    h('tbody', null, (results?.ranking || []).map((p) => h('tr', null,
      h('td', null, String(p.rank)), h('td', null, nameOf(p.pid)),
      cols.map((c) => h('td', null, String(p.detail?.[c.id] ?? ''))),
      h('td.total', null, String(p.score))))));
}

// ---------- QR ----------
export function qrSvg(text) {
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
  return s('svg', { viewBox: `0 0 ${n + 2 * m} ${n + 2 * m}`, class: 'qr', 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code to join' },
    s('rect', { width: n + 2 * m, height: n + 2 * m, fill: '#f7f2e6' }),
    s('path', { d, fill: '#06281f' }));
}

export function qrPanel(url, code) {
  return h('div.qr-panel', null, qrSvg(url),
    h('div.qr-code-label', null, 'Room code'),
    h('div.qr-code', null, code),
    h('div.qr-url', null, url.replace(/^https?:\/\//, '')));
}
