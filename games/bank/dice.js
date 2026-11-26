// Dice faces drawn with CSS pips. Shared by the TV and phone views.
import { h, reducedMotion } from '../../engine/ui/dom.js';

const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

export function die(v, cls = '') {
  const el = h('div.die' + (cls ? '.' + cls : ''), { 'aria-label': v ? `die showing ${v}` : 'die' });
  setFace(el, v);
  return el;
}

export function setFace(el, v) {
  el.replaceChildren(...Array.from({ length: 9 }, (_, i) => h('span.pip' + (v && PIPS[v].includes(i + 1) ? '.on' : ''))));
  el.dataset.v = v || '';
}

// Tumble dice locally while the host resolves the roll. Returns a stop() function.
export function tumble(dice) {
  if (reducedMotion()) { dice.forEach((d) => setFace(d, null)); return () => {}; }
  const t = setInterval(() => dice.forEach((d) => setFace(d, 1 + Math.floor(Math.random() * 6))), 90);
  return () => clearInterval(t);
}

export function diceRow(pub, cls = '') {
  const a = die(pub.dice?.[0], cls), b = die(pub.dice?.[1], cls);
  const row = h('div.dice-row' + (pub.rolling ? '.rolling' : ''), null, a, b);
  return { row, dice: [a, b] };
}

export function lastRollText(pub) {
  const r = pub.lastRoll;
  if (!r || pub.rolling) return '';
  if (r.kind === 'seventy') return 'Safe 7: +70!';
  if (r.kind === 'double') return 'Doubles! Bank doubled';
  if (r.kind === 'bust') return 'Seven. Bust!';
  return `+${r.added}`;
}
