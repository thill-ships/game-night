// Toasts, bottom sheets, confirms, full-screen moments, flashes, haptics.
import { h, clear, reducedMotion } from './dom.js';

let toastWrap;
export function toast(text, { kind = '', ms = 2600 } = {}) {
  if (!toastWrap) toastWrap = document.body.appendChild(h('div.toasts', { 'aria-live': 'polite' }));
  const t = h('div.toast' + (kind ? '.' + kind : ''), null, text);
  toastWrap.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// Bottom sheet. content: Node | (close) => Node. Returns close().
export function sheet(content, { title, onClose, dismissable = true, cls = '' } = {}) {
  const back = h('div.sheet-back' + (cls ? '.' + cls : ''));
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    back.classList.add('out');
    setTimeout(() => back.remove(), 220);
    onClose && onClose();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  if (title) panel.append(h('div.sheet-head', null, h('h3', null, title),
    dismissable ? h('button.icon-btn', { 'aria-label': 'Close', onclick: close }, '✕') : null));
  panel.append(typeof content === 'function' ? content(close) : content);
  back.append(panel);
  back.addEventListener('click', (e) => { if (e.target === back && dismissable) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

export function closeSheets() {
  document.querySelectorAll('.sheet-back').forEach((b) => b.remove());
}

export function confirmSheet({ title, body, yes = 'Confirm', no = 'Cancel', danger = false }) {
  return new Promise((res) => {
    let answered = false;
    const close = sheet((close) => h('div.confirm', null,
      body ? h('p', null, body) : null,
      h('div.row', null,
        h('button.btn.secondary', { onclick: () => { answered = true; res(false); close(); } }, no),
        h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => { answered = true; res(true); close(); } }, yes))),
    { title, onClose: () => { if (!answered) res(false); } });
    void close;
  });
}

// Full-screen moment: "Seven!", "Reveal!", "Final round!"
export function moment(text, { sub = '', kind = '', ms = 1600 } = {}) {
  const m = h('div.moment' + (kind ? '.' + kind : ''), { 'aria-live': 'assertive' },
    h('div.moment-text', null, text), sub ? h('div.moment-sub', null, sub) : null);
  document.body.append(m);
  setTimeout(() => m.classList.add('out'), ms);
  setTimeout(() => m.remove(), ms + 500);
}

export function flash(kind = 'gold') {
  if (reducedMotion()) return;
  const f = h('div.flash.' + kind);
  document.body.append(f);
  setTimeout(() => f.remove(), 700);
}

export function vibrate(pattern = 40) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch {}
}

export { clear };
