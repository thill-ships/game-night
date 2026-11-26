// Bank TV renderer.
import { h } from '../../engine/ui/dom.js';
import { diceRow, tumble, lastRollText } from './dice.js';
import { leaderPids, bankReason } from './rules.js';

export const tv = {
  header: (pub) => `Round ${pub.round} of ${pub.rounds}`,
  phase: (pub) => pub.phaseText,

  render(el, pub, ui) {
    const { kit } = ui;
    ui.local.stopTumble?.();
    const { row, dice } = diceRow(pub, 'xl');
    if (pub.rolling) ui.local.stopTumble = tumble(dice);

    const roller = pub.roller;
    const rollerName = roller ? ui.name(roller) : null;
    let turn;
    if (pub.phase !== 'roll') turn = h('div.turn-line', null, '');
    else if (pub.rolling) turn = h('div.turn-line', null, h('span', null, h('b', null, rollerName), ' is rolling…'));
    else if (roller) turn = h('div.turn-line', null, h('span', null, h('b', null, rollerName), "'s roll"),
      h('small', null, pub.phoneRoll ? (ui.isOnline(roller) ? 'Roll from your phone' : 'Offline. Roll for them or skip') : 'Press Space or Roll'));
    else turn = h('div.turn-line', null, 'Nobody left to roll');

    const leaders = leaderPids(pub);
    const rollDisabled = pub.phase !== 'roll' || pub.rolling || !roller;
    const main = h('section.bank-main', null,
      h('div.bank-label', null, 'Bank'),
      h('div.bank-num' + (pub.bank >= 300 ? '.hot' : ''), { 'aria-live': 'polite' }, String(pub.bank)),
      row,
      h('div.last-roll' + (pub.lastRoll ? '.' + pub.lastRoll.kind : ''), null, lastRollText(pub)),
      turn,
      h('div.bank-actions', null,
        h('button.btn' + (pub.phoneRoll ? '.secondary' : '.primary.big'), { disabled: rollDisabled, onclick: () => ui.hostAct({ type: 'roll' }) }, pub.phoneRoll ? 'Roll for them' : '🎲 Roll')));

    const rows = pub.players.map((p) => {
      const reason = bankReason(pub, p.pid);
      return {
        pid: p.pid, name: ui.name(p.pid), on: ui.isOnline(p.pid),
        active: p.pid === roller && pub.phase === 'roll',
        leader: leaders.includes(p.pid),
        tags: p.pid === roller && pub.phase === 'roll' ? [{ text: pub.rolling ? 'rolling' : 'to roll', kind: 'roll' }] : [],
        status: p.banked ? `banked +${p.gain}` : pub.phase === 'roll' ? 'in' : '',
        dim: p.banked,
        score: p.score,
        extra: h('button.btn.sm.bank-backup', { disabled: !!reason, title: reason || `Bank for ${ui.name(p.pid)}`, onclick: () => ui.act(p.pid, { type: 'bank' }) }, 'Bank'),
      };
    });
    const waitingRows = pub.waiting.map((pid) => ({ pid, name: ui.name(pid), on: ui.isOnline(pid), status: 'joins next round', dim: true }));
    const board = h('aside.bank-board', null,
      h('h3', null, 'Scores'),
      kit.scoreboard([...rows, ...waitingRows]));

    el.append(h('div.bank-tv', null, main, board));
    if (pub.phase === 'roundEnd') el.append(roundEnd(pub, ui));
  },

  fx(kind, data, ui) {
    const { kit } = ui;
    if (kind === 'bust') kit.flash('red');
    else if (kind === 'dbl') { kit.flash('gold'); kit.moment('Doubles!', { sub: `Bank doubled to ${data.bank}`, kind: 'gold', ms: 1200 }); }
    else if (kind === 'seventy') { kit.flash('gold'); kit.moment('+70', { sub: 'Safe seven!', kind: 'gold', ms: 1100 }); }
    else if (kind === 'finalRound') kit.moment('Final round!', { kind: 'gold' });
    else if (kind === 'banked') kit.toast(`${ui.name(data.pid)} banked ${data.amount}`);
  },
};

function roundEnd(pub, ui) {
  const re = pub.roundEnd;
  const bust = re.reason === 'bust';
  const last = pub.round >= pub.rounds;
  const sorted = pub.players.slice().sort((a, b) => (re.gains[b.pid] || 0) - (re.gains[a.pid] || 0));
  return h('div.round-end' + (bust ? '.bust' : ''), null, h('div.re-card', null,
    h('div.re-title', null, bust ? 'Seven!' : 'Everyone banked'),
    h('div.re-sub', null, `Round ${pub.round} of ${pub.rounds} · Bank reached ${re.bank}`),
    h('ul.re-gains', null, sorted.map((p) => h('li' + ((re.gains[p.pid] || 0) > 0 ? '.won' : '.lost'), null,
      h('span', null, ui.name(p.pid)),
      h('b', null, (re.gains[p.pid] || 0) > 0 ? `+${re.gains[p.pid]}` : '0'),
      h('span.re-total', null, String(p.score))))),
    h('div.row.center', null,
      h('button.btn.secondary', { disabled: !ui.canUndo, onclick: () => ui.undo() }, '↶ Undo'),
      h('button.btn.primary.big', { onclick: () => ui.hostAct({ type: 'next' }) }, last ? 'See results' : 'Next round'))));
}
