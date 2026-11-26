// Bank phone renderer.
import { h } from '../../engine/ui/dom.js';
import { diceRow, tumble, lastRollText } from './dice.js';
import { bankReason, findP, leaderPids } from './rules.js';

export const phone = {
  render(el, pub, priv, me, ui) {
    const { kit } = ui;
    ui.local.stopTumble?.();
    const mine = findP(pub, me.pid);
    const waitingSeat = pub.waiting.includes(me.pid);
    const { row, dice } = diceRow(pub, 'sm');
    if (pub.rolling) ui.local.stopTumble = tumble(dice);

    const myTurn = pub.phase === 'roll' && pub.roller === me.pid && !pub.rolling;
    let turnText;
    if (pub.phase !== 'roll') turnText = '';
    else if (pub.rolling) turnText = pub.roller === me.pid ? 'Rolling…' : `${ui.name(pub.roller)} is rolling…`;
    else if (myTurn) turnText = pub.phoneRoll ? 'Your roll!' : 'Your roll. The TV rolls for you';
    else if (pub.roller) turnText = `${ui.name(pub.roller)}'s roll`;

    const parts = [
      h('div.bp-top', null, h('span', null, `Round ${pub.round} of ${pub.rounds}`), kit.phasePill(pub.phaseText.text, pub.phaseText.kind || '')),
      h('div.bp-bank', null,
        h('div.bank-label', null, 'Bank'),
        h('div.bank-num' + (pub.bank >= 300 ? '.hot' : ''), null, String(pub.bank)),
        row,
        h('div.last-roll' + (pub.lastRoll ? '.' + pub.lastRoll.kind : ''), null, lastRollText(pub))),
      turnText ? h('div.bp-turn' + (myTurn ? '.mine' : ''), null, turnText) : null,
    ];

    if (!me.isSpectator) {
      // On your turn, Roll is the biggest thing on the screen; Bank is always the smaller button.
      if (myTurn && pub.phoneRoll) {
        parts.push(kit.actionButton('🎲 ROLL', { kind: 'primary', big: true, cls: 'roll-btn', onClick: () => ui.send({ type: 'roll' }) }));
      }
      const reason = bankReason(pub, me.pid);
      parts.push(kit.actionButton('BANK', {
        kind: 'secondary', big: true, cls: 'bank-btn' + (reason ? '' : '.ready'), reason,
        sub: reason ? null : `+${pub.bank}`,
        onClick: () => ui.send({ type: 'bank' }),
      }));
    }

    if (mine) {
      const sorted = pub.players.map((p) => p.score).sort((a, b) => b - a);
      const rank = sorted.indexOf(mine.score) + 1;
      parts.push(h('div.bp-me', null,
        h('div', null, h('span.lbl', null, 'Your score'), h('b', null, String(mine.score))),
        h('div', null, h('span.lbl', null, 'Place'), h('b', null, ordinal(rank)), h('span.lbl', null, ` of ${pub.players.length}`))));
    } else if (waitingSeat) {
      parts.push(h('p.hint.center', null, "You'll take a seat with 0 points when the next round starts."));
    }

    if (pub.phase === 'roundEnd') parts.push(roundCard(pub, me, ui));

    const leaders = leaderPids(pub);
    parts.push(h('h3.bp-h', null, 'Scores'), kit.scoreboard(pub.players.map((p) => ({
      pid: p.pid, name: ui.name(p.pid), on: ui.roster.find((r) => r.pid === p.pid)?.on,
      active: p.pid === pub.roller && pub.phase === 'roll', leader: leaders.includes(p.pid),
      status: p.banked ? `+${p.gain}` : '', dim: p.banked, score: p.score,
    })), { compact: true, mePid: me.pid }));

    el.append(h('div.bank-phone', null, parts));
  },

  fx(kind, data, ui, me) {
    const { kit } = ui;
    if (kind === 'bust') {
      kit.flash('red');
      if (data.caught?.includes(me.pid)) { ui.vibrate([200, 80, 200]); kit.moment('Seven!', { sub: 'You got 0 this round', kind: 'bad', ms: 1400 }); }
    } else if (kind === 'dbl' || kind === 'seventy') { kit.flash('gold'); ui.vibrate(30); }
    else if (kind === 'banked' && data.pid === me.pid) ui.vibrate(40);
    else if (kind === 'finalRound') kit.moment('Final round!', { kind: 'gold', ms: 1200 });
  },
};

function roundCard(pub, me, ui) {
  const re = pub.roundEnd;
  const g = re.gains[me.pid];
  const mine = g != null;
  return h('div.card.bp-round' + (re.reason === 'bust' ? '.bust' : ''), null,
    h('div.re-title', null, re.reason === 'bust' ? 'Seven!' : 'Everyone banked'),
    mine ? h('div.bp-gain' + (g > 0 ? '.won' : '.lost'), null, g > 0 ? `You banked +${g}` : 'You got 0 this round') : null,
    h('p.hint', null, pub.round >= pub.rounds ? 'That was the last round!'
      : ui.controller === me.pid ? 'Tap Next round below when everyone is ready.'
      : ui.controller ? `Waiting for ${ui.name(ui.controller)} to start the next round.` : 'Waiting for the next round.'));
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
