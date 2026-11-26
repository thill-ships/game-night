// Bank rules. Pure and deterministic given state + intent + ctx (rng, isOnline).
// No DOM, no network. The engine passes a cloned draft to apply().

export const ROLL_MS = 950;

export function setup({ seats, options }) {
  const s = {
    phase: 'roll',            // roll | roundEnd | over
    round: 1,
    rounds: Number(options.rounds) || 20,
    early: options.early !== false,
    phoneRoll: options.phoneRoll !== false,
    players: seats.map((pid) => newPlayer(pid, 0)),
    waiting: [],              // late joiners, seated at the next round
    bank: 0,
    rollCount: 0,
    dice: null,
    rolling: false,
    roller: null,
    lastRoller: null,
    lastRoll: null,           // { dice, kind: 'add'|'seventy'|'double'|'bust', added }
    roundEnd: null,           // { reason: 'bust'|'allBanked', bank, gains:{pid:n} }
  };
  s.roller = nextRoller(s, s.players.length ? s.players[s.players.length - 1].pid : null, null);
  return s;
}

function newPlayer(pid, round) {
  return { pid, score: 0, banked: false, gain: 0, rounds: [], joined: round };
}

export const findP = (s, pid) => s.players.find((p) => p.pid === pid);
export const inRound = (s) => s.players.filter((p) => !p.banked);
export const safeRoll = (s) => s.rollCount < 3; // the NEXT roll is roll 1–3

// Next roller after `fromPid` in seat order: unbanked players only. When players
// roll from phones, offline players are skipped as long as someone online is still in.
export function nextRoller(s, fromPid, isOnline) {
  const cands = s.players.filter((p) => !p.banked);
  if (!cands.length) return null;
  const n = s.players.length;
  let start = s.players.findIndex((p) => p.pid === fromPid);
  const order = [];
  for (let k = 1; k <= n; k++) order.push(s.players[(start + k + n) % n]);
  const eligible = order.filter((p) => !p.banked);
  if (s.phoneRoll && isOnline) {
    const on = eligible.find((p) => isOnline(p.pid));
    if (on) return on.pid;
  }
  return eligible[0].pid;
}

export function validate(s, pid, intent) {
  const t = intent.type;
  if (pid === 'system') return null;
  if (s.phase === 'over') return 'The game is over';
  if (pid === 'host') {
    if (t === 'roll' || t === 'skip') {
      if (s.phase !== 'roll') return 'The round is over';
      if (s.rolling) return 'The dice are already rolling';
      if (!s.roller) return 'Nobody left to roll';
      return null;
    }
    if (t === 'next') return s.phase === 'roundEnd' ? null : 'The round is still going';
    return 'Unknown action';
  }
  const me = findP(s, pid);
  if (t === 'roll') {
    if (!me) return 'You join next round';
    if (s.phase !== 'roll') return 'The round is over';
    if (s.rolling) return 'The dice are already rolling';
    if (s.roller !== pid) return "It's not your roll";
    if (!s.phoneRoll) return 'The TV rolls this game';
    return null;
  }
  if (t === 'bank') return bankReason(s, pid);
  return 'Unknown action';
}

// Why this player can't bank right now (null = they can). Shared by rules and UI.
export function bankReason(s, pid) {
  const me = findP(s, pid);
  if (!me) return s.waiting.includes(pid) ? 'You join next round' : "You're watching";
  if (s.phase === 'over') return 'The game is over';
  if (s.phase !== 'roll') return 'Round over';
  if (me.banked) return `Banked ${me.gain}`;
  if (s.rolling) return 'Too late to bank this roll';
  if (s.bank <= 0) return 'Nothing in the Bank yet';
  if (!s.early && s.rollCount < 3) return 'Banking opens after roll 3';
  return null;
}

export function apply(s, pid, intent, ctx) {
  const t = intent.type;
  const name = ctx.name || ((p) => p);
  switch (t) {
    case 'roll': {
      s.rolling = true;
      ctx.schedule(ROLL_MS, { type: 'resolve' });
      return;
    }
    case 'resolve': {
      if (!s.rolling) return;
      s.rolling = false;
      const d = [ctx.rng.die(), ctx.rng.die()];
      const sum = d[0] + d[1], dbl = d[0] === d[1];
      const safe = safeRoll(s);
      s.rollCount += 1;
      s.dice = d;
      s.lastRoller = s.roller;
      const who = name(s.roller);
      if (safe) {
        if (sum === 7) { s.bank += 70; s.lastRoll = { dice: d, kind: 'seventy', added: 70 }; ctx.fx('seventy', { dice: d }); ctx.log(`${who} rolled 7: +70`); }
        else { s.bank += sum; s.lastRoll = { dice: d, kind: 'add', added: sum }; ctx.log(`${who} rolled ${sum}${dbl ? ' (doubles)' : ''}`); }
      } else if (sum === 7) {
        s.lastRoll = { dice: d, kind: 'bust', added: 0 };
        const caught = inRound(s).map((p) => p.pid);
        ctx.log(`${who} rolled 7. Bust!`);
        ctx.fx('bust', { caught, bank: s.bank });
        endRound(s, 'bust');
        return;
      } else if (dbl) {
        s.lastRoll = { dice: d, kind: 'double', added: s.bank };
        s.bank *= 2;
        ctx.fx('dbl', { dice: d, bank: s.bank });
        ctx.log(`${who} rolled doubles: Bank doubled to ${s.bank}`);
      } else {
        s.bank += sum; s.lastRoll = { dice: d, kind: 'add', added: sum };
        ctx.log(`${who} rolled ${sum}`);
      }
      s.roller = nextRoller(s, s.roller, ctx.isOnline);
      return;
    }
    case 'bank': {
      const p = findP(s, pid);
      p.banked = true; p.gain = s.bank; p.score += s.bank;
      ctx.log(`${name(pid)} banked ${s.bank}`);
      ctx.fx('banked', { pid, amount: s.bank });
      if (!inRound(s).length) { endRound(s, 'allBanked'); ctx.fx('allBanked', {}); return; }
      if (s.roller === pid) s.roller = nextRoller(s, pid, ctx.isOnline);
      return;
    }
    case 'skip': {
      const from = s.roller;
      s.roller = nextRoller(s, s.roller, ctx.isOnline);
      ctx.log(`Skipped ${name(from)}`);
      return;
    }
    case 'next': {
      if (s.round >= s.rounds) { s.phase = 'over'; ctx.log('Game over'); return; }
      s.round += 1;
      startRound(s, ctx);
      if (s.round === s.rounds) ctx.fx('finalRound', {});
      return;
    }
    case 'timeout': {
      if (intent.pid === s.roller && s.phase === 'roll' && !s.rolling) {
        ctx.log(`${name(s.roller)} ran out of time, so the dice rolled for them`);
        s.rolling = true;
        ctx.schedule(ROLL_MS, { type: 'resolve' });
      }
      return;
    }
    case '@join': {
      if (findP(s, intent.pid) || s.waiting.includes(intent.pid)) return;
      if (s.phase === 'roll' && s.rollCount === 0 && !s.rolling) {
        s.players.push(newPlayer(intent.pid, s.round));
        ctx.log(`${name(intent.pid)} joined`);
      } else {
        s.waiting.push(intent.pid);
        ctx.log(`${name(intent.pid)} joins next round`);
      }
      return;
    }
    case '@leave': {
      s.waiting = s.waiting.filter((x) => x !== intent.pid);
      const idx = s.players.findIndex((p) => p.pid === intent.pid);
      if (idx < 0) return;
      let next = s.roller;
      if (s.roller === intent.pid) next = nextRoller(s, intent.pid, ctx.isOnline);
      s.players.splice(idx, 1);
      if (next === intent.pid) next = null;
      s.roller = next;
      if (s.lastRoller === intent.pid) s.lastRoller = s.roller;
      if (s.phase === 'roll' && !inRound(s).length) {
        s.rolling = false;
        if (s.players.length) endRound(s, 'allBanked'); else s.phase = 'over';
      }
      return;
    }
  }
}

function endRound(s, reason) {
  s.phase = 'roundEnd';
  s.rolling = false;
  const gains = {};
  for (const p of s.players) {
    const g = p.banked ? p.gain : 0;
    gains[p.pid] = g;
    p.rounds.push(g);
  }
  s.roundEnd = { reason, bank: s.bank, gains };
}

function startRound(s, ctx) {
  s.phase = 'roll';
  s.bank = 0; s.rollCount = 0; s.dice = null; s.rolling = false; s.lastRoll = null; s.roundEnd = null;
  for (const pid of s.waiting) { const p = newPlayer(pid, s.round); p.rounds = Array(s.round - 1).fill(0); s.players.push(p); }
  s.waiting = [];
  for (const p of s.players) { p.banked = false; p.gain = 0; }
  s.roller = nextRoller(s, s.lastRoller && findP(s, s.lastRoller) ? s.lastRoller : (s.players.at(-1)?.pid ?? null), ctx.isOnline);
}

export function activePids(s) {
  return s.phase === 'roll' && !s.rolling && s.roller ? [s.roller] : [];
}

export function isOver(s) { return s.phase === 'over'; }

export function results(s) {
  const sorted = s.players.slice().sort((a, b) => b.score - a.score);
  const ranking = sorted.map((p) => ({
    pid: p.pid,
    rank: 1 + sorted.filter((q) => q.score > p.score).length,
    score: p.score,
    detail: {
      banked: p.rounds.filter((g) => g > 0).length,
      best: Math.max(0, ...p.rounds),
      busted: p.rounds.filter((g) => g === 0).length,
    },
  }));
  return {
    headline: ranking.length ? null : 'Game over',
    ranking,
    columns: [{ id: 'banked', label: 'Rounds banked' }, { id: 'best', label: 'Best round' }, { id: 'busted', label: 'Got 0' }],
  };
}

export function leaderPids(s) {
  const top = Math.max(...s.players.map((p) => p.score));
  return top > 0 ? s.players.filter((p) => p.score === top).map((p) => p.pid) : [];
}

export function phaseLabel(s) {
  if (s.phase === 'over') return { text: 'Game over' };
  if (s.phase === 'roundEnd') return { text: s.roundEnd?.reason === 'bust' ? 'Bust!' : 'Round over', kind: s.roundEnd?.reason === 'bust' ? 'bad' : '' };
  if (s.rolling) return { text: 'Rolling…', kind: 'warn' };
  if (safeRoll(s)) return { text: `Safe roll ${s.rollCount + 1} of 3`, kind: 'ok' };
  return { text: '7 busts!', kind: 'bad' };
}
