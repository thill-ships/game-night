// "The remote": the controller phone can do everything the TV buttons can, so
// nobody has to touch the host computer once it shows the QR code.
// Every action is an encrypted '@ctl' intent that the host checks against R.controller.
import * as kit from './ui/index.js';

const { h, confirmSheet, sheet } = kit;
export const TIMERS = [0, 30, 60, 90];

const defaults = (M) => Object.fromEntries((M.options || []).map((o) => [o.id, o.default]));

// ctx: { S, pid, byId, nameOf, ctl(op, args) → Promise<{ok, err}> }

export function pendingCards({ S, ctl }) {
  if (!S.pending?.length) return null;
  return h('div.ctl-pending', null, S.pending.map((p) => h('div.card.ctl-pend', null,
    h('p', null, h('b', null, p.name), ' is trying to reconnect from a new device. Allow?'),
    h('div.row', null,
      kit.actionButton('Allow', { kind: 'primary', onClick: () => ctl('approve', { pid: p.pid }) }),
      kit.actionButton(p.fresh ? 'No, new player' : 'Deny', { kind: 'secondary', onClick: () => ctl('deny', { pid: p.pid }) })))));
}

export function lobbyPanel(ctx) {
  const { S, byId, ctl, pid } = ctx;
  const games = (S.games || []).map((id) => byId[id]).filter(Boolean);
  const sel = byId[S.lobby.gameId] || games[0];
  const n = S.roster.length;
  const playing = S.roster.filter((p) => !p.sitOut).length;
  let reason = null;
  if (playing < sel.minPlayers) reason = `${sel.name} needs at least ${sel.minPlayers} players`;
  else if (playing > sel.maxPlayers) reason = `${sel.name} seats ${sel.maxPlayers}. Set the others to "Sitting out".`;

  const cur = { ...defaults(sel), ...S.lobby.options };
  const options = (sel.options || []).map((o) => h('div.opt', null,
    h('span.opt-label', null, o.label),
    o.type === 'bool'
      ? h('button.toggle' + (cur[o.id] ? '.on' : ''), { role: 'switch', 'aria-checked': cur[o.id] ? 'true' : 'false', onclick: () => ctl('option', { id: o.id, value: !cur[o.id] }) }, cur[o.id] ? 'On' : 'Off')
      : h('div.seg', null, o.values.map((v) => h('button' + (cur[o.id] === v ? '.on' : ''), { onclick: () => ctl('option', { id: o.id, value: v }) }, String(v))))));

  return h('div.ctl-lobby', null,
    h('div.ctl-badge', null, '🎮 You have the remote'),
    pendingCards(ctx),
    h('h3', null, 'Pick a game'),
    h('div.ctl-games', null, games.map((g) => {
      const few = n < g.minPlayers;
      const count = g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`;
      return h('button.game-card' + (g.id === sel.id ? '.selected' : '') + (few ? '.greyed' : ''), {
        'aria-pressed': g.id === sel.id ? 'true' : 'false', onclick: () => ctl('select', { gameId: g.id }),
      }, h('div.gc-name', null, g.name), h('div.gc-tag', null, g.tagline || ''),
      h('div.gc-meta', null, h('span', null, count), h('span', null, `${g.estMinutes?.[0]}–${g.estMinutes?.[1]} min`)),
      few ? h('div.gc-note', null, g.minPlayers === g.maxPlayers ? `${g.name} is ${g.minPlayers} players` : `Needs ${g.minPlayers}+ players`) : null);
    })),
    options.length ? h('div.options', null, options) : null,
    kit.actionButton(`Start ${sel.name}`, { kind: 'primary', big: true, cls: 'ctl-start', reason, onClick: () => ctl('start') }),
    h('button.btn.ghost', { onclick: () => kit.showTutorial(sel) }, `How to play ${sel.name}`),
    h('h3', null, `Players (${n})`),
    h('ol.roster', null, S.roster.map((p, i) => h('li.roster-row' + (p.sitOut ? '.out' : ''), null,
      kit.onlineDot(p.on),
      h('span.seat', null, String(i + 1)),
      h('span.r-name', null, p.name, p.pid === S.controller ? h('span.tag.remote', null, '🎮') : null),
      h('span.r-tools', null,
        h('button.icon-btn', { 'aria-label': `Move ${p.name} up`, disabled: i === 0, onclick: () => ctl('move', { pid: p.pid, dir: -1 }) }, '↑'),
        h('button.icon-btn', { 'aria-label': `Move ${p.name} down`, disabled: i === n - 1, onclick: () => ctl('move', { pid: p.pid, dir: 1 }) }, '↓'),
        h('button.chip' + (p.sitOut ? '.off' : '.on'), { onclick: () => ctl('sitOut', { pid: p.pid, value: !p.sitOut }) }, p.sitOut ? 'Sitting out' : 'Playing'),
        p.pid === pid ? null : h('button.icon-btn.danger', { 'aria-label': `Kick ${p.name}`, onclick: async () => {
          if (await confirmSheet({ title: `Remove ${p.name}?`, body: 'They can scan the code again to rejoin.', yes: 'Remove', danger: true })) ctl('kick', { pid: p.pid });
        } }, '✕'))))));
}

// Sticky bar at the bottom of the controller's phone during a game:
// the game's main host action (Next round, Roll…) plus a sheet with the rest.
export function gameBar(ctx, M, pub, uiLike) {
  const { S, ctl } = ctx;
  const actions = M.hostActions ? (M.hostActions(pub, uiLike) || []) : [];
  const run = (a) => (a.pid ? ctl('actFor', { pid: a.pid, intent: a.intent }) : ctl('hostAct', { intent: a.intent }));
  const primary = actions.find((a) => a.primary && !a.reason);
  const openRemote = () => sheet((close) => h('div.menu', null,
    actions.map((a) => kit.actionButton(a.label, { kind: 'secondary', reason: a.reason, onClick: async () => { close(); await run(a); } })),
    M.undoable ? kit.actionButton('↶ Undo last move', { kind: 'secondary', reason: S.canUndo ? null : 'Nothing to undo', onClick: async () => { close(); await ctl('undo'); } }) : null,
    timerRow(ctx, close),
    kit.actionButton('End game → lobby', { kind: 'danger', onClick: async () => {
      close();
      if (await confirmSheet({ title: 'End this game?', body: 'Everyone goes back to the lobby. Scores are lost.', yes: 'End game', danger: true })) ctl('lobby');
    } })), { title: '🎮 Remote' });
  return h('div.ctl-bar', null,
    primary ? kit.actionButton(primary.label, { kind: 'primary', big: true, cls: 'ctl-primary', onClick: () => run(primary) }) : null,
    h('button.btn.secondary.ctl-more', { onclick: openRemote, 'aria-label': 'Remote controls' }, '🎮', primary ? null : h('span', null, ' Remote')));
}

export function resultsControls(ctx) {
  const { S, ctl } = ctx;
  return h('div.ctl-results', null,
    kit.actionButton('Play again', { kind: 'primary', big: true, onClick: () => ctl('again') }),
    kit.actionButton('Back to lobby', { kind: 'secondary', big: true, onClick: () => ctl('lobby') }),
    S.canUndo ? kit.actionButton('↶ Undo last move', { kind: 'ghost', onClick: () => ctl('undo') }) : null);
}

export function timerRow({ S, ctl }, close) {
  return h('div.opt', null, h('span.opt-label', null, 'Turn timer'),
    h('div.seg', null, TIMERS.map((s) => h('button' + (S.timer === s ? '.on' : ''), {
      onclick: () => { ctl('timer', { sec: s }); close && close(); },
    }, s ? s + 's' : 'Off'))));
}

export function handoffSheet({ S, pid, ctl }) {
  const others = S.roster.filter((p) => p.pid !== pid);
  sheet((close) => h('div.menu', null,
    others.length ? h('p.hint', null, 'Who should hold the remote?') : h('p.hint', null, 'Nobody else is here yet.'),
    others.map((p) => h('button.btn.secondary', { onclick: () => { close(); ctl('handoff', { pid: p.pid }); } }, kit.onlineDot(p.on), ' ', p.name))),
  { title: 'Hand off the remote' });
}
