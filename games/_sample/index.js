// Dev-only engine test game. Visible in the picker only with ?dev.
import * as R from './rules.js';
import { h, s } from '../../engine/ui/dom.js';

const COLS = 8, CW = 170, CH = 230, GAP = 24;

export default {
  id: 'sample', name: 'Card Test', tagline: 'Engine test: hidden hands and a simultaneous reveal.',
  minPlayers: 2, maxPlayers: 6, estMinutes: [2, 5],
  css: new URL('./sample.css', import.meta.url).href,
  options: [],
  tutorial: [
    { title: 'Secret pick', body: 'Everyone picks one card from their hidden hand. Nobody sees picks until all are in.' },
    { title: 'Reveal', body: 'All picks flip at once and land on the board on the TV.' },
    { title: 'Keep 2 of 3', body: 'Then you are offered 3 cards and must keep at least 2. After 2 rounds, the highest revealed total wins.' },
  ],
  setup: R.setup, validate: R.validate, apply: R.apply,
  publicView: R.publicView, privateView: R.privateView,
  activePids: R.activePids, isOver: R.isOver, results: R.results,
  undoable: false, // hidden information: no undo
  hostActions: () => [],

  tv: {
    header: (pub) => `Round ${pub.round} of ${pub.rounds}`,
    phase: (pub) => ({ text: pub.phase === 'pick' ? 'Secret pick' : pub.phase === 'keep' ? 'Keep 2 of 3' : 'Done', kind: 'warn' }),
    render(el, pub, ui) {
      const { kit } = ui;
      const rows = Math.max(2, Math.ceil(pub.board.length / COLS));
      const W = COLS * (CW + GAP) + GAP, H = rows * (CH + GAP) + GAP;
      const b = kit.board({ width: W, height: H, cls: 'sample-board' });
      for (let r = 0; r < rows; r++) for (let c = 0; c < COLS; c++)
        b.svg.append(s('rect', { x: GAP + c * (CW + GAP), y: GAP + r * (CH + GAP), width: CW, height: CH, rx: 16, class: 'slot' }));
      pub.board.forEach((card, i) => {
        const x = GAP + (i % COLS) * (CW + GAP), y = GAP + Math.floor(i / COLS) * (CH + GAP);
        b.svg.append(s('g', { class: 'bcard', transform: `translate(${x} ${y})` },
          s('rect', { width: CW, height: CH, rx: 16 }),
          s('text', { x: CW / 2, y: CH / 2 + 30, 'text-anchor': 'middle', class: 'num' }, String(card.card)),
          s('text', { x: CW / 2, y: CH - 22, 'text-anchor': 'middle', class: 'who' }, ui.name(card.pid))));
      });
      el.append(h('div.sample-tv', null,
        h('div.sample-status', null,
          kit.waiting(pub.phase === 'pick' ? 'Everyone is choosing a card in secret' : 'Everyone is choosing which cards to keep', { ready: pub.ready.length, total: pub.seats.length }),
          kit.scoreboard(pub.seats.map((pid) => ({ pid, name: ui.name(pid), on: ui.isOnline(pid), active: !pub.ready.includes(pid), status: pub.ready.includes(pid) ? 'ready' : 'thinking…', score: pub.handCounts[pid] + ' cards' })))),
        b.el));
    },
    fx(kind, data, ui) { if (kind === 'reveal') ui.kit.moment('Reveal!', { kind: 'gold', ms: 1100 }); },
  },

  phone: {
    render(el, pub, priv, me, ui) {
      const { kit } = ui;
      const parts = [h('div.bp-top', null, h('span', null, `Round ${pub.round} of ${pub.rounds}`), kit.phasePill(pub.phase === 'pick' ? 'Secret pick' : 'Keep 2 of 3', 'warn'))];
      const cardNode = (c) => h('span.scard', null, String(c.v));
      if (!priv) {
        parts.push(kit.waiting('Watching', { ready: pub.ready.length, total: pub.seats.length }));
      } else if (pub.phase === 'pick' && priv.picked == null) {
        const store = ui.local.pick || (ui.local.pick = {});
        const hd = kit.hand({ cards: priv.hand.map((v) => ({ id: String(v), v })), render: cardNode, mode: 'single', store, onChange: () => btnWrap.replaceChildren(btn()) });
        const btn = () => kit.actionButton('Play this card', {
          big: true, reason: hd.ok() ? null : 'Tap a card first',
          onClick: async () => { const ok = await kit.confirmSheet({ title: `Play ${hd.selected()[0]}?`, body: 'Picks are secret until everyone has chosen.', yes: 'Play it' }); if (ok) await ui.send({ type: 'pick', card: Number(hd.selected()[0]) }); },
        });
        const btnWrap = h('div', null, btn());
        parts.push(h('h3', null, 'Your hand'), hd.el, btnWrap);
      } else if (pub.phase === 'keep' && priv.offer && !priv.kept) {
        const store = ui.local.keep || (ui.local.keep = {});
        const hd = kit.hand({ cards: priv.offer.map((v) => ({ id: String(v), v })), render: cardNode, mode: 'multi', min: 2, max: 3, store, onChange: () => btnWrap.replaceChildren(btn()) });
        const btn = () => kit.actionButton('Keep these', {
          big: true, reason: hd.ok() ? null : 'Keep at least 2 of 3',
          onClick: () => ui.send({ type: 'keep', cards: hd.selected().map(Number) }),
        });
        const btnWrap = h('div', null, btn());
        parts.push(h('h3', null, 'Keep at least 2'), hd.el, btnWrap, h('h3', null, 'Your hand'), kit.hand({ cards: priv.hand.map((v) => ({ id: String(v), v })), render: cardNode, mode: 'none' }).el);
      } else {
        parts.push(kit.waiting('Waiting for others', { ready: pub.ready.length, total: pub.seats.length }));
        if (priv.picked != null && pub.phase === 'pick') parts.push(h('p.hint.center', null, `You picked ${priv.picked}`));
        parts.push(h('h3', null, 'Your hand'), kit.hand({ cards: priv.hand.map((v) => ({ id: String(v), v })), render: cardNode, mode: 'none' }).el);
      }
      el.append(h('div.sample-phone', null, parts));
    },
    fx(kind, data, ui) { if (kind === 'reveal') { ui.vibrate(50); ui.kit.flash('gold'); } },
  },
};
