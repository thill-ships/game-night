// "Card Test": a dev-only game that exercises engine features Bank doesn't:
// hidden hands, a simultaneous secret pick + reveal, keep-at-least-2-of-3, board surface.
export const ROUNDS = 2;

export function setup({ seats, rng }) {
  const deck = rng.shuffle(Array.from({ length: 40 }, (_, i) => i + 1));
  const hands = {};
  for (const pid of seats) hands[pid] = deck.splice(0, 5).sort((a, b) => a - b);
  return { phase: 'pick', round: 1, seats: seats.slice(), deck, hands, picks: {}, offers: {}, kept: {}, board: [] };
}

export function validate(s, pid, intent) {
  if (pid === 'system') return intent.type === '@join' ? 'New players can join the next game' : null;
  if (pid === 'host') return 'Unknown action';
  if (!s.seats.includes(pid)) return "You're watching";
  if (intent.type === 'pick') {
    if (s.phase !== 'pick') return 'Not picking right now';
    if (s.picks[pid] != null) return 'You already picked';
    if (!s.hands[pid].includes(intent.card)) return "That card isn't in your hand";
    return null;
  }
  if (intent.type === 'keep') {
    if (s.phase !== 'keep') return 'Not choosing right now';
    if (s.kept[pid]) return 'You already chose';
    const cards = Array.isArray(intent.cards) ? intent.cards : [];
    if (new Set(cards).size !== cards.length) return 'Pick each card once';
    if (cards.length < 2) return 'Keep at least 2 of the 3';
    if (!cards.every((c) => s.offers[pid].includes(c))) return "Those cards weren't offered to you";
    return null;
  }
  return 'Unknown action';
}

export function apply(s, pid, intent, ctx) {
  switch (intent.type) {
    case 'pick': doPick(s, pid, intent.card, ctx); break;
    case 'keep': doKeep(s, pid, intent.cards, ctx); break;
    case 'timeout': {
      const p = intent.pid;
      if (s.phase === 'pick' && s.picks[p] == null && s.hands[p]?.length) doPick(s, p, s.hands[p][0], ctx);
      else if (s.phase === 'keep' && !s.kept[p] && s.offers[p]) doKeep(s, p, s.offers[p].slice(0, 2), ctx);
      break;
    }
    case '@leave': {
      s.seats = s.seats.filter((x) => x !== intent.pid);
      delete s.hands[intent.pid]; delete s.picks[intent.pid]; delete s.offers[intent.pid]; delete s.kept[intent.pid];
      if (!s.seats.length) s.phase = 'over';
      else if (s.phase === 'pick' && allIn(s, s.picks)) reveal(s, ctx);
      else if (s.phase === 'keep' && allIn(s, s.kept)) nextRound(s, ctx);
      break;
    }
  }
}

const allIn = (s, obj) => s.seats.every((p) => obj[p] != null);

function doPick(s, pid, card, ctx) {
  s.picks[pid] = card;
  s.hands[pid] = s.hands[pid].filter((c) => c !== card);
  ctx.log(`${ctx.name(pid)} is ready`);
  if (allIn(s, s.picks)) reveal(s, ctx);
}

function reveal(s, ctx) {
  const shown = s.seats.map((pid) => ({ pid, card: s.picks[pid], round: s.round }));
  s.board.push(...shown);
  ctx.fx('reveal', { cards: shown });
  ctx.log(`Reveal! ${shown.map((x) => `${ctx.name(x.pid)} ${x.card}`).join(', ')}`);
  s.phase = 'keep';
  for (const pid of s.seats) s.offers[pid] = s.deck.splice(0, 3);
}

function doKeep(s, pid, cards, ctx) {
  s.kept[pid] = cards.slice();
  s.hands[pid] = [...s.hands[pid], ...cards].sort((a, b) => a - b);
  if (allIn(s, s.kept)) nextRound(s, ctx);
}

function nextRound(s, ctx) {
  if (s.round >= ROUNDS) { s.phase = 'over'; ctx.log('Game over'); return; }
  s.round += 1; s.phase = 'pick'; s.picks = {}; s.offers = {}; s.kept = {};
  ctx.log(`Round ${s.round}`);
}

export function publicView(s) {
  const done = s.phase === 'pick' ? s.picks : s.phase === 'keep' ? s.kept : {};
  return {
    phase: s.phase, round: s.round, rounds: ROUNDS, seats: s.seats,
    ready: s.seats.filter((p) => done[p] != null),
    handCounts: Object.fromEntries(s.seats.map((p) => [p, s.hands[p].length])),
    deckCount: s.deck.length,
    board: s.board,
  };
}

export function privateView(s, pid) {
  if (!s.seats.includes(pid)) return null;
  return { hand: s.hands[pid], picked: s.picks[pid] ?? null, offer: s.offers[pid] || null, kept: s.kept[pid] || null };
}

export function activePids(s) {
  if (s.phase === 'pick') return s.seats.filter((p) => s.picks[p] == null);
  if (s.phase === 'keep') return s.seats.filter((p) => !s.kept[p]);
  return [];
}

export const isOver = (s) => s.phase === 'over';

export function results(s) {
  const totals = s.seats.map((pid) => {
    const mine = s.board.filter((b) => b.pid === pid);
    return { pid, score: mine.reduce((a, b) => a + b.card, 0), cards: mine.map((b) => b.card).join(' + ') };
  }).sort((a, b) => b.score - a.score);
  return {
    ranking: totals.map((t) => ({ pid: t.pid, score: t.score, rank: 1 + totals.filter((q) => q.score > t.score).length, detail: { cards: t.cards } })),
    columns: [{ id: 'cards', label: 'Revealed' }],
  };
}
