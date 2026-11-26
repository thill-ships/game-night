// Host engine: the single source of truth for a room.
// Owns roster, presence, key pinning, seats, game lifecycle, undo, timers,
// persistence, and the TV screens (lobby, game chrome, results).
import { V, T, params, DEV, newRoomCode, cleanName, clone, urlWith } from './proto.js';
import { createNet } from './net.js';
import * as C from './crypto.js';
import { createRng } from './rng.js';
import * as kit from './ui/index.js';
import { loadGames } from '../games/registry.js';
import { BUILD } from './version.js';
import { watchUpdates } from './update.js';

const { h, clear, toast, sheet, confirmSheet } = kit;
const STORE_KEY = 'gn.host.v1';
const UNDO_MAX = 40;
const CONTROLLER_GRACE = 120000; // controller offline this long → the next online phone takes over
const TIMERS = [0, 30, 60, 90];

export async function startHost(root) {
  document.body.className = 'tv';
  const games = await loadGames({ dev: DEV });
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const rng = createRng({ seed: params.get('seed') });

  // ---------- persistent room state ----------
  let R = load();
  if (!R || !R.code) R = freshRoom();
  if (R.game && !byId[R.game.id]) R.game = null;
  R.retired = R.retired || {};
  if (R.controller === undefined || (R.controller && !R.roster.some((p) => p.pid === R.controller))) R.controller = R.roster[0]?.pid ?? null;
  if (!byId[R.lobby.gameId]) R.lobby = { gameId: games[0].id, options: defaults(games[0]) };
  history.replaceState(null, '', urlWith('host'));

  function freshRoom() {
    return {
      code: newRoomCode(), ver: 1, fxSeq: 0,
      roster: [], pins: {}, pending: {}, retired: {}, controller: null,
      lobby: { gameId: games[0].id, options: defaults(games[0]) },
      settings: { timer: 0 },
      game: null,
    };
  }
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } }
  let saveQueued = false;
  function save() {
    if (saveQueued) return; saveQueued = true;
    queueMicrotask(() => { saveQueued = false; saveNow(); });
  }
  function saveNow() { try { localStorage.setItem(STORE_KEY, JSON.stringify(R)); } catch (e) { console.warn('save failed', e); } }
  addEventListener('pagehide', saveNow);

  // ---------- volatile state ----------
  const seen = {};          // pid -> last heard (ms)
  const shared = {};        // pid -> { x, key: Promise<CryptoKey> }
  const nonces = {};        // pid -> Map(nonce -> ack)
  const privCache = {};     // pid -> JSON of last private view
  let onlineSig = '';
  let tvFxSeen = R.fxSeq;   // don't replay effects after a TV refresh
  let forged = 0;
  const startedAt = Date.now(); // after a TV refresh, nobody counts as long-offline yet
  let updateReady = null;       // a newer deploy is waiting; applied when no game is running
  const tvLocal = {};       // per-game scratch space for TV renderers

  const hostKP = await C.loadKeyPair('host:' + R.code);
  const net = createNet(R.code, { onMessage, onStatus: () => render() });

  const mod = () => R.game && byId[R.game.id];
  const player = (pid) => R.roster.find((p) => p.pid === pid);
  const nameOf = (pid) => player(pid)?.name || 'Someone';
  const isOn = (pid) => Date.now() - (seen[pid] || 0) < T.ONLINE_MS;

  // ---------- messaging ----------
  function onMessage(m) {
    if (m.v !== V) return; // phones on another version show "Refresh to update" from our state message
    if (m.t === 'hello') onHello(m);
    else if (m.t === 'act') onAct(m);
    else if (m.t === 'bye') onBye(m);
  }
  const sendTo = (pid, msg) => net.send({ ...msg, v: V, room: R.code, to: pid });

  function onHello(m) {
    const pid = String(m.pid || '').slice(0, 40);
    if (!pid) return;
    const name = cleanName(m.name) || 'Player';
    const key = m.key ? C.pubOnly(m.key) : null;
    const kx = key ? key.x : 'plain'; // notices carry kx so two devices sharing a pid can tell them apart
    const p = player(pid);
    const wasOn = isOn(pid);
    if (p) {
      const pin = R.pins[pid];
      const match = key ? (pin !== 'plain' && C.sameKey(pin, key)) : pin === 'plain';
      if (!match) {
        if ((R.retired[pid] || []).includes(kx)) { sendTo(pid, { t: 'notice', kind: 'replaced', kx }); return; }
        // Known seat, different device/key: never silently replace. Ask the host.
        requestApproval(pid, { name: p.name, key: key || 'plain' });
        sendTo(pid, { t: 'notice', kind: 'approve-wait', kx });
        return;
      }
      seen[pid] = Date.now();
      if (m.waiting) sendTo(pid, { t: 'notice', kind: 'approved', kx });
      if (p.name !== name) { p.name = uniqueName(name, pid); bump(); }
      else if (!wasOn) bump();
      else if (m.need) broadcastState();
      if (m.need || !wasOn) sendPriv(pid, true);
      return;
    }
    // A device we've never seen. Already waiting to take over someone's seat?
    if (Object.values(R.pending).some((x) => x.from === pid)) { sendTo(pid, { t: 'notice', kind: 'approve-wait', kx }); return; }
    // Same name as an offline player: probably their phone lost its storage. Ask the host.
    const twin = R.roster.find((q) => q.name.toLowerCase() === name.toLowerCase() && !isOn(q.pid) && !R.pending[q.pid]);
    if (twin) {
      requestApproval(twin.pid, { name: twin.name, key: key || 'plain', from: pid });
      sendTo(pid, { t: 'notice', kind: 'approve-wait', kx });
      return;
    }
    addPlayer(pid, name, key);
  }

  function requestApproval(pid, req) {
    const prev = R.pending[pid];
    R.pending[pid] = { ...req, at: Date.now() };
    if (!prev || JSON.stringify(prev.key) !== JSON.stringify(req.key) || prev.from !== req.from) bump(); // the remote phone sees it too
  }

  function addPlayer(pid, name, key) {
    seen[pid] = Date.now();
    R.pins[pid] = key || 'plain';
    R.roster.push({ pid, name: uniqueName(name, pid), sitOut: false, plain: !key, pseq: 0 });
    if (!R.controller) R.controller = pid; // the first phone to join is the remote
    if (R.game && !R.game.over) tryJoinGame(pid);
    bump();
    sendPriv(pid, true);
  }

  function uniqueName(name, pid) {
    let n = name, i = 2;
    while (R.roster.some((p) => p.pid !== pid && p.name.toLowerCase() === n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }

  function sharedFor(pid) {
    const pin = R.pins[pid];
    if (!pin || pin === 'plain' || !hostKP) return null;
    if (!shared[pid] || shared[pid].x !== pin.x) shared[pid] = { x: pin.x, key: C.deriveShared(hostKP.privateKey, pin) };
    return shared[pid].key;
  }

  async function onAct(m) {
    const pid = m.pid;
    if (!player(pid)) return;
    let payload;
    if (m.ct) {
      const k = sharedFor(pid);
      if (!k) return;
      try { payload = await C.unseal(await k, m.iv, m.ct); } catch { forged++; return; } // forged or stale key: drop
    } else if (m.plain && R.pins[pid] === 'plain') {
      payload = m.plain;
      if (mod()?.privateView) return sendTo(pid, { t: 'ack', n: String(payload?.n), ok: false, err: "This browser can't play hidden-card games" });
    } else return;
    if (!payload || payload.n == null) return;
    seen[pid] = Date.now();
    const n = String(payload.n);
    const cache = nonces[pid] || (nonces[pid] = new Map());
    if (cache.has(n)) return sendTo(pid, { t: 'ack', n, ...cache.get(n) });
    const err = playerIntent(pid, payload.intent);
    const res = err ? { ok: false, err } : { ok: true };
    cache.set(n, res);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    sendTo(pid, { t: 'ack', n, ...res });
  }

  function onBye(m) {
    // Unauthenticated, so only honour it as "went offline"; leaving the room needs an encrypted intent.
    if (player(m.pid)) { seen[m.pid] = 0; bump(); }
  }

  function playerIntent(pid, intent) {
    if (!intent || typeof intent.type !== 'string') return 'Bad request';
    if (intent.type === '@leave-room') { removePlayer(pid, false); return null; }
    if (intent.type === '@ctl') return controlOp(pid, intent);
    if (intent.type.startsWith('@')) return 'Not allowed';
    const G = R.game;
    if (!G) return 'No game is running';
    if (G.over) return 'The game is over';
    if (!G.seats.includes(pid)) return "You're watching this game";
    return applyIntent(pid, intent, {});
  }

  // ---------- game engine core ----------
  function applyIntent(actor, intent, { byHost = false, system = false } = {}) {
    const G = R.game, M = mod();
    if (!G || !M) return 'No game is running';
    if (G.over && !system) return 'The game is over';
    const info = { byHost, isOnline: isOn };
    const err = M.validate(G.state, actor, intent, info);
    if (err) return err;
    const prevActive = G.over ? [] : M.activePids(G.state);
    const prev = { state: G.state, log: G.log };
    const draft = clone(G.state);
    const log = G.log.slice();
    const fx = [], sched = [];
    const ctx = {
      rng, byHost, isOnline: isOn, now: Date.now(),
      schedule: (ms, i) => sched.push({ at: Date.now() + ms, intent: i }),
      fx: (kind, data = {}) => fx.push({ kind, data }),
      log: (t) => log.push({ t: String(t), at: Date.now() }),
      name: nameOf,
    };
    try { M.apply(draft, actor, intent, ctx); } catch (e) { console.error('apply failed', e); return 'Something went wrong'; }
    if (!system && M.undoable) { G.undo.push(prev); if (G.undo.length > UNDO_MAX) G.undo.shift(); }
    G.state = draft;
    G.log = log.slice(-40);
    for (const f of fx) G.fx.push({ id: ++R.fxSeq, ...f });
    G.fx = G.fx.slice(-8);
    for (const s of sched) { G.sched.push(s); setTimeout(runDue, Math.max(0, s.at - Date.now()) + 5); }
    afterChange(prevActive);
    return null;
  }

  function afterChange(prevActive = []) {
    const G = R.game, M = mod();
    if (G && M) {
      const over = !!M.isOver(G.state);
      if (over && !G.over) { G.results = M.results(G.state); G.fx.push({ id: ++R.fxSeq, kind: '@over', data: {} }); }
      G.over = over;
      if (!over) G.results = null;
      const act = over ? [] : M.activePids(G.state);
      if (!R.settings.timer || !act.length) G.deadline = null;
      else if (!G.deadline || act.some((p) => !prevActive.includes(p))) G.deadline = Date.now() + R.settings.timer * 1000;
    }
    bump();
  }

  function runDue() {
    const G = R.game;
    if (!G || !G.sched.length) return;
    const now = Date.now();
    G.sched.sort((a, b) => a.at - b.at);
    while (R.game === G && G.sched.length && G.sched[0].at <= now) {
      const s = G.sched.shift();
      const err = applyIntent('system', s.intent, { system: true });
      if (err) { console.warn('scheduled intent rejected', s.intent, err); save(); }
    }
  }

  function hostAct(intent) {
    const err = applyIntent('host', intent, { byHost: true });
    if (err) toast(err, { kind: 'bad' });
    return err;
  }
  function actFor(pid, intent) {
    const err = applyIntent(pid, intent, { byHost: true });
    if (err) toast(err, { kind: 'bad' });
    return err;
  }
  function undo() {
    const err = undoOp();
    toast(err || 'Undone', err ? {} : undefined);
  }
  function undoOp() {
    const G = R.game;
    if (!G || !mod()?.undoable || !G.undo.length) return 'Nothing to undo';
    const prev = G.undo.pop();
    G.state = prev.state; G.log = prev.log; G.sched = [];
    G.fx.push({ id: ++R.fxSeq, kind: '@undo', data: {} });
    G.fx = G.fx.slice(-8);
    afterChange([]);
    return null;
  }

  function tryJoinGame(pid) {
    const G = R.game, M = mod();
    if (!G || !M || G.seats.includes(pid) || G.seats.length >= M.maxPlayers) return;
    if (M.privateView && player(pid)?.plain) return;
    if (M.validate(G.state, 'system', { type: '@join', pid }, { isOnline: isOn })) return;
    G.seats.push(pid);
    if (applyIntent('system', { type: '@join', pid }, { system: true })) G.seats = G.seats.filter((x) => x !== pid);
  }

  function removePlayer(pid, kicked) {
    const G = R.game;
    if (G && G.seats.includes(pid)) {
      G.seats = G.seats.filter((x) => x !== pid);
      applyIntent('system', { type: '@leave', pid }, { system: true });
    }
    R.roster = R.roster.filter((p) => p.pid !== pid);
    if (R.controller === pid) R.controller = (R.roster.find((p) => isOn(p.pid)) || R.roster[0])?.pid ?? null;
    delete R.pins[pid]; delete R.pending[pid]; delete R.retired[pid];
    for (const [k, v] of Object.entries(R.pending)) if (v.from === pid) delete R.pending[k];
    delete shared[pid]; delete nonces[pid]; delete privCache[pid]; delete seen[pid];
    if (kicked) sendTo(pid, { t: 'notice', kind: 'kicked' });
    bump();
  }

  function eligibleSeats(M) {
    return R.roster.filter((p) => !p.sitOut && !(M.privateView && p.plain)).map((p) => p.pid);
  }

  function startGame(again = false) {
    const prevG = R.game;
    const id = again && prevG ? prevG.id : R.lobby.gameId;
    const M = byId[id];
    const seats = again && prevG ? prevG.seats.filter((pid) => player(pid)) : eligibleSeats(M);
    const reason = startReason(M, seats.length);
    if (reason) return reason;
    const options = again && prevG ? prevG.options : { ...defaults(M), ...R.lobby.options };
    let state;
    try { state = M.setup({ seats: seats.slice(), options, rng }); } catch (e) { console.error(e); return 'Could not start the game'; }
    R.game = { id, seats, options, state, log: [], undo: [], fx: [{ id: ++R.fxSeq, kind: '@start', data: {} }], sched: [], over: false, results: null, deadline: null, startedAt: Date.now() };
    afterChange([]);
    return null;
  }
  function tvStart(again) { const err = startGame(again); if (err) toast(err, { kind: 'bad' }); }
  function startReason(M, n) {
    if (n < M.minPlayers) return `${M.name} needs at least ${M.minPlayers} players`;
    if (n > M.maxPlayers) return `${M.name} seats at most ${M.maxPlayers}. Tap "Sit out" for the others.`;
    return null;
  }
  function backToLobby() {
    if (R.game) R.lobby = { gameId: R.game.id, options: { ...R.game.options } };
    R.game = null;
    bump();
    maybeApplyUpdate();
  }

  // ---------- lobby edits (shared by the TV and the controller phone) ----------
  function selectGame(id) {
    if (R.lobby.gameId !== id) { R.lobby = { gameId: id, options: defaults(byId[id]) }; bump(); }
  }
  function setOption(id, v) {
    const M = byId[R.lobby.gameId];
    R.lobby.options = { ...defaults(M), ...R.lobby.options, [id]: v };
    bump();
  }
  function moveSeat(pid, d) {
    const i = R.roster.findIndex((p) => p.pid === pid), j = i + d;
    if (i < 0 || j < 0 || j >= R.roster.length) return;
    [R.roster[i], R.roster[j]] = [R.roster[j], R.roster[i]];
    bump();
  }
  function setSitOut(pid, v) { const p = player(pid); if (p) { p.sitOut = !!v; bump(); } }
  function setTimer(sec) { R.settings.timer = sec; if (R.game) R.game.deadline = null; afterChange([]); }
  function setController(pid) {
    if (R.controller === pid) return;
    R.controller = pid;
    sendTo(pid, { t: 'notice', kind: 'controller' });
    bump();
  }

  // ---------- the controller phone ("the remote") ----------
  // Anything the TV buttons can do, the controller can do from their phone (except New room).
  function controlOp(pid, x) {
    const op = x.op;
    if (op === 'claim') {
      if (R.controller === pid) return null;
      if (R.controller && isOn(R.controller)) return `${nameOf(R.controller)} has the remote`;
      setController(pid);
      return null;
    }
    if (R.controller !== pid) return `Only ${nameOf(R.controller)} can do that (they have the remote)`;
    const G = R.game;
    const lobbyOnly = () => (G ? 'Finish this game first' : null);
    switch (op) {
      case 'select': {
        if (lobbyOnly()) return lobbyOnly();
        if (!games.some((g) => g.id === x.gameId)) return 'Unknown game';
        selectGame(x.gameId); return null;
      }
      case 'option': {
        if (lobbyOnly()) return lobbyOnly();
        const o = (byId[R.lobby.gameId].options || []).find((q) => q.id === x.id);
        if (!o) return 'Unknown option';
        if (o.type === 'bool' ? typeof x.value !== 'boolean' : !o.values.includes(x.value)) return 'Not an allowed value';
        setOption(o.id, x.value); return null;
      }
      case 'move': if (lobbyOnly()) return lobbyOnly(); moveSeat(x.pid, x.dir < 0 ? -1 : 1); return null;
      case 'sitOut': if (lobbyOnly()) return lobbyOnly(); setSitOut(x.pid, !!x.value); return null;
      case 'kick':
        if (x.pid === pid) return "You can't remove yourself. Hand off the remote first.";
        if (!player(x.pid)) return 'They already left';
        removePlayer(x.pid, true); return null;
      case 'start': if (G && !G.over) return 'A game is already running'; return startGame(false);
      case 'again': if (!G || !G.over) return 'The game is still going'; return startGame(true);
      case 'lobby': if (!G) return null; backToLobby(); return null;
      case 'undo': return undoOp();
      case 'hostAct':
        if (!x.intent || typeof x.intent.type !== 'string' || x.intent.type.startsWith('@')) return 'Bad request';
        return applyIntent('host', x.intent, { byHost: true });
      case 'actFor':
        if (!x.intent || typeof x.intent.type !== 'string' || x.intent.type.startsWith('@')) return 'Bad request';
        if (!G || !G.seats.includes(x.pid)) return "They're not in this game";
        return applyIntent(x.pid, x.intent, { byHost: true });
      case 'approve': if (!R.pending[x.pid]) return 'Already handled'; approve(x.pid); return null;
      case 'deny': if (!R.pending[x.pid]) return 'Already handled'; deny(x.pid); return null;
      case 'timer': if (!TIMERS.includes(x.sec)) return 'Not an allowed timer'; setTimer(x.sec); return null;
      case 'handoff': if (!player(x.pid)) return 'They left'; setController(x.pid); return null;
      default: return 'Unknown action';
    }
  }

  // ---------- updates ----------
  // A newer deploy is out. Reload the TV only when no game is running (state is saved,
  // so phones just see a short blip). Guarded so a stale CDN can't cause a reload loop.
  function maybeApplyUpdate() {
    if (!updateReady) return;
    if (R.game) { render(); return; } // never mid-game (or on the podium): wait for the lobby
    const key = 'gn.reloadedFor';
    if (sessionStorage.getItem(key) === updateReady) { render(); return; }
    sessionStorage.setItem(key, updateReady);
    toast('Updating to the latest version…');
    saveNow();
    setTimeout(() => location.reload(), 1500);
  }
  watchUpdates((build) => { updateReady = build; maybeApplyUpdate(); });

  // ---------- publishing ----------
  function bump() {
    R.ver++;
    save();
    computePrivs();
    broadcastState();
    flushPrivs();
    render();
  }

  const dirtyPriv = new Set();
  function computePrivs() {
    const G = R.game, M = mod();
    for (const p of R.roster) {
      const pv = G && M && M.privateView && G.seats.includes(p.pid) ? M.privateView(G.state, p.pid) : null;
      const js = JSON.stringify(pv ?? null);
      if (privCache[p.pid] !== js) {
        const first = privCache[p.pid] === undefined;
        privCache[p.pid] = js;
        if (!(first && js === 'null')) { p.pseq = (p.pseq || 0) + 1; dirtyPriv.add(p.pid); }
      }
    }
  }
  function flushPrivs() { for (const pid of [...dirtyPriv]) { dirtyPriv.delete(pid); sendPriv(pid); } }

  async function sendPriv(pid) {
    const p = player(pid);
    if (!p) return;
    if (privCache[pid] === undefined) computePrivs();
    const k = sharedFor(pid);
    if (!k) return;
    const js = privCache[pid] ?? 'null';
    try {
      const env = await C.seal(await k, { pv: JSON.parse(js) });
      net.send({ t: 'priv', v: V, room: R.code, to: pid, ver: R.ver, seq: p.pseq || 0, ...env });
    } catch (e) { console.warn('priv send failed', e); }
  }

  function stateMsg() {
    const G = R.game, M = mod();
    let game = null;
    if (G && M) {
      const pub = M.publicView(G.state);
      game = {
        id: G.id, phase: pub?.phase ?? null, pub,
        active: G.over ? [] : M.activePids(G.state),
        fx: G.fx, options: G.options, seats: G.seats, log: G.log.slice(-12),
        over: G.over, results: G.over ? G.results : null,
        timerLeft: G.deadline ? Math.max(0, G.deadline - Date.now()) : null,
        hasPriv: !!M.privateView,
      };
    }
    return {
      t: 'state', v: V, room: R.code, ver: R.ver,
      hostKey: hostKP?.publicJwk || null,
      roster: R.roster.map((p, i) => ({
        pid: p.pid, name: p.name, seat: i, on: isOn(p.pid),
        spectator: !!G && !G.seats.includes(p.pid), sitOut: !!p.sitOut, pseq: p.pseq || 0,
      })),
      lobby: R.lobby, timer: R.settings.timer, game,
      controller: R.controller,
      pending: Object.entries(R.pending).filter(([pid]) => player(pid)).map(([pid, x]) => ({ pid, name: nameOf(pid), fresh: !!x.from })),
      games: games.map((g) => g.id),
      canUndo: !!(G && M && M.undoable && G.undo.length && !G.over) || !!(G && G.over && M?.undoable && G.undo.length),
      build: BUILD,
    };
  }
  function broadcastState() { net.send(stateMsg()); }

  // ---------- clock ----------
  let lastBroadcast = 0;
  setInterval(() => {
    const now = Date.now();
    runDue();
    const sig = R.roster.map((p) => (isOn(p.pid) ? 1 : 0)).join('');
    if (sig !== onlineSig) { onlineSig = sig; bump(); lastBroadcast = now; return; }
    const G = R.game;
    if (G && G.deadline && now >= G.deadline && !G.over) {
      G.deadline = null;
      const act = mod().activePids(G.state);
      for (const pid of act) applyIntent('system', { type: 'timeout', pid }, { system: true });
      if (!act.length) save();
    }
    if (R.controller && now - Math.max(seen[R.controller] || 0, startedAt) > CONTROLLER_GRACE) {
      const next = R.roster.find((p) => p.pid !== R.controller && isOn(p.pid));
      if (next) { toast(`${next.name} now has the remote`); setController(next.pid); lastBroadcast = now; return; }
    }
    if (now - lastBroadcast >= T.STATE_EVERY) { lastBroadcast = now; broadcastState(); }
    if (G && G.deadline) updateTimerChip();
  }, 250);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { runDue(); broadcastState(); } });

  // ---------- TV rendering ----------
  let renderQueued = false;
  function render() {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  const ui = {
    kit, rng: null,
    get room() { return R.code; },
    name: nameOf,
    isOnline: isOn,
    get roster() { return R.roster.map((p, i) => ({ pid: p.pid, name: p.name, seat: i, on: isOn(p.pid) })); },
    act: (pid, intent) => actFor(pid, intent),
    hostAct: (intent) => hostAct(intent),
    undo: () => undo(),
    get canUndo() { return !!(R.game && mod()?.undoable && R.game.undo.length); },
    get active() { const G = R.game; return G && !G.over ? mod().activePids(G.state) : []; },
    get local() { const id = R.game?.id || '_'; return tvLocal[id] || (tvLocal[id] = {}); },
  };

  function renderNow() {
    const G = R.game, M = mod();
    clear(root);
    if (G && M) renderGame(G, M); else renderLobby();
    renderPending();
    // one-shot effects
    if (G && M) {
      for (const f of G.fx) {
        if (f.id <= tvFxSeen) continue;
        tvFxSeen = f.id;
        if (f.kind === '@undo') continue;
        try { M.tv.fx && M.tv.fx(f.kind, f.data, ui); } catch (e) { console.error(e); }
      }
    }
    tvFxSeen = Math.max(tvFxSeen, R.fxSeq);
  }

  function joinUrl() {
    return location.origin + location.pathname + '?g=' + R.code + (params.has('local') ? '&local' : '');
  }

  function renderLobby() {
    const sel = byId[R.lobby.gameId];
    const eligible = eligibleSeats(sel);
    const reason = startReason(sel, eligible.length);
    root.append(h('div.lobby', null,
      h('aside.lobby-join', null,
        h('div.brand', null, h('span.brand-mark', null, '♠'), ' Game Night'),
        kit.qrPanel(joinUrl(), R.code),
        h('p.hint', null, 'Scan with your phone camera to join'),
        kit.connBadge(net.status)),
      h('main.lobby-main', null,
        h('h2', null, 'Pick a game'),
        h('div.picker', null, games.map((g) => gameCard(g))),
        optionsPanel(sel),
        h('div.start-row', null,
          kit.actionButton(`Start ${sel.name}`, { big: true, reason, onClick: () => tvStart(false) }),
          h('button.btn.secondary', { onclick: () => kit.showTutorial(sel, { cls: 'tv' }) }, 'How to play')),
        R.controller ? h('p.hint.remote-hint', null, '🎮 ', h('b', null, nameOf(R.controller)), "'s phone is the remote. Pick the game and start it from there.") : null,
        updateReady ? h('p.hint', null, 'A new version is ready and will load after this game.') : null),
      h('aside.lobby-players', null,
        h('h2', null, `Players `, h('span.count', null, String(R.roster.length))),
        R.roster.length ? rosterList(sel) : h('p.empty', null, 'Waiting for players… scan the code to join.'),
        h('div.lobby-tools', null,
          h('button.btn.ghost', { onclick: openMenu }, '☰ Menu'),
          h('button.btn.ghost', { onclick: fullscreen }, '⛶ Full screen')))));
  }

  function gameCard(g) {
    const n = R.roster.length;
    const selected = R.lobby.gameId === g.id;
    const tooFew = n < g.minPlayers;
    const tooMany = n > g.maxPlayers;
    const count = g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`;
    let note = null;
    if (tooFew) note = g.minPlayers === g.maxPlayers ? `${g.name} is ${g.minPlayers} players` : `Needs ${g.minPlayers}+ players`;
    else if (tooMany) note = `${g.name} seats ${g.maxPlayers}. Extra players watch.`;
    return h('button.game-card' + (selected ? '.selected' : '') + (tooFew ? '.greyed' : ''), {
      'aria-pressed': selected ? 'true' : 'false',
      onclick: () => selectGame(g.id),
    },
    h('div.gc-name', null, g.name, g.dev ? h('span.tag', null, 'dev') : null),
    h('div.gc-tag', null, g.tagline || ''),
    h('div.gc-meta', null, h('span', null, count), h('span', null, `${g.estMinutes?.[0]}–${g.estMinutes?.[1]} min`)),
    note ? h('div.gc-note', null, note) : null);
  }

  function optionsPanel(M) {
    const opts = M.options || [];
    if (!opts.length) return null;
    const cur = { ...defaults(M), ...R.lobby.options };
    const setOpt = (id, v) => setOption(id, v);
    return h('div.options', null, opts.map((o) => h('div.opt', null,
      h('span.opt-label', null, o.label),
      o.type === 'bool'
        ? h('button.toggle' + (cur[o.id] ? '.on' : ''), { role: 'switch', 'aria-checked': cur[o.id] ? 'true' : 'false', onclick: () => setOpt(o.id, !cur[o.id]) }, cur[o.id] ? 'On' : 'Off')
        : h('div.seg', null, o.values.map((v) => h('button' + (cur[o.id] === v ? '.on' : ''), { onclick: () => setOpt(o.id, v) }, String(v)))))));
  }

  function rosterList(M) {
    return h('ol.roster', null, R.roster.map((p, i) => {
      const hiddenBlocked = M.privateView && p.plain;
      return h('li.roster-row' + (p.sitOut || hiddenBlocked ? '.out' : ''), { dataset: { pid: p.pid } },
        kit.onlineDot(isOn(p.pid)),
        h('span.seat', null, String(i + 1)),
        h('span.r-name', null, p.name, R.controller === p.pid ? h('span.tag.remote', { title: 'This phone is the remote' }, '🎮 remote') : null, hiddenBlocked ? h('span.tag.bad', null, "Browser can't do hidden cards") : null),
        h('span.r-tools', null,
          h('button.icon-btn', { title: 'Move up', 'aria-label': `Move ${p.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button.icon-btn', { title: 'Move down', 'aria-label': `Move ${p.name} down`, disabled: i === R.roster.length - 1, onclick: () => move(i, 1) }, '↓'),
          h('button.chip' + (p.sitOut ? '.off' : '.on'), { title: 'Toggle playing / sitting out', onclick: () => setSitOut(p.pid, !p.sitOut) }, p.sitOut ? 'Sitting out' : 'Playing'),
          h('button.icon-btn.danger', { title: 'Kick', 'aria-label': `Kick ${p.name}`, onclick: () => kick(p) }, '✕')));
    }));
  }
  function move(i, d) { moveSeat(R.roster[i].pid, d); }
  async function kick(p) {
    if (await confirmSheet({ title: `Remove ${p.name}?`, body: 'They can scan the code again to rejoin.', yes: 'Remove', danger: true })) removePlayer(p.pid, true);
  }

  function renderPending() {
    const ids = Object.keys(R.pending).filter((pid) => player(pid));
    if (!ids.length) return;
    root.append(h('div.pending', { role: 'alertdialog' }, ids.map((pid) => h('div.pending-row', null,
      h('span', null, h('b', null, nameOf(pid)), ' is trying to reconnect from a new device. Allow?'),
      h('button.btn.primary', { onclick: () => approve(pid) }, 'Allow'),
      h('button.btn.secondary', { onclick: () => deny(pid) }, R.pending[pid].from ? 'No, new player' : 'Deny')))));
  }
  function approve(pid) {
    const pend = R.pending[pid];
    if (!pend) return;
    const old = R.pins[pid];
    R.retired[pid] = [...(R.retired[pid] || []), old === 'plain' ? 'plain' : old?.x].filter(Boolean).slice(-5);
    R.pins[pid] = pend.key;
    const p = player(pid);
    if (p) p.plain = pend.key === 'plain';
    delete R.pending[pid]; delete shared[pid]; delete nonces[pid]; delete privCache[pid];
    seen[pid] = Date.now();
    const kx = pend.key === 'plain' ? 'plain' : pend.key.x;
    // A device with a new pid adopts the old seat's pid.
    sendTo(pend.from || pid, { t: 'notice', kind: 'approved', kx, adopt: pend.from ? pid : undefined, name: pend.from ? p?.name : undefined });
    bump();
    sendPriv(pid);
  }
  function deny(pid) {
    const pend = R.pending[pid];
    if (!pend) return;
    delete R.pending[pid];
    const kx = pend.key === 'plain' ? 'plain' : pend.key.x;
    if (pend.from) {
      // Different person with the same name: let them in as a new player.
      addPlayer(pend.from, pend.name, pend.key === 'plain' ? null : pend.key);
      sendTo(pend.from, { t: 'notice', kind: 'approved', kx });
    } else {
      sendTo(pid, { t: 'notice', kind: 'denied', kx });
      bump();
    }
  }

  let timerChip = null;
  function updateTimerChip() {
    const G = R.game;
    if (!timerChip) return;
    const left = G && G.deadline ? Math.max(0, Math.ceil((G.deadline - Date.now()) / 1000)) : null;
    timerChip.textContent = left == null ? '' : `⏱ ${left}s`;
    timerChip.classList.toggle('low', left != null && left <= 5);
  }

  function renderGame(G, M) {
    const pub = M.publicView(G.state);
    const header = M.tv.header ? M.tv.header(pub, ui) : '';
    const phase = M.tv.phase ? M.tv.phase(pub, ui) : null;
    const actions = (!G.over && M.hostActions) ? M.hostActions(pub, ui) || [] : [];
    timerChip = h('span.timer');
    const stage = h('div.stage');
    root.append(h('div.tv-game', null,
      h('header.topbar', null,
        h('span.tb-game', null, M.name),
        header ? h('span.tb-header', null, header) : null,
        phase ? kit.phasePill(phase.text || phase, phase.kind || '') : null,
        h('span.spacer'),
        timerChip,
        updateReady ? h('span.pill.warn', { title: 'Loads when you go back to the lobby' }, 'Update after this game') : null,
        kit.joinChip(R.code),
        kit.connBadge(net.status),
        actions.map((a) => h('button.btn' + (a.primary ? '.primary' : '.secondary') + '.sm', { disabled: !!a.reason, title: a.reason || (a.primary ? 'Space' : ''), onclick: () => a.pid ? actFor(a.pid, a.intent) : hostAct(a.intent) }, a.label)),
        M.undoable ? h('button.btn.secondary.sm', { disabled: !G.undo.length, title: 'U', onclick: undo }, '↶ Undo') : null,
        h('button.btn.ghost.sm', { onclick: openMenu }, '☰ Menu'),
        h('button.btn.ghost.sm', { 'aria-label': 'Full screen', onclick: fullscreen }, '⛶')),
      stage,
      kit.historyStrip(G.log)));
    try { M.tv.render(stage, pub, ui); } catch (e) { console.error(e); stage.append(h('p.error', null, 'Render error: ' + e.message)); }
    updateTimerChip();
    if (G.over) root.append(resultsOverlay(G, M));
  }

  function resultsOverlay(G, M) {
    return h('div.results-overlay', null, h('div.results-card', null,
      h('h1.results-title', null, kit.winnerLine(G.results, nameOf)),
      kit.podium(G.results, nameOf),
      h('div.row.center', null,
        M.undoable && G.undo.length ? h('button.btn.secondary', { onclick: undo }, '↶ Undo') : null,
        h('button.btn.primary.big', { onclick: () => tvStart(true) }, 'Play again'),
        h('button.btn.secondary.big', { onclick: backToLobby }, 'Back to lobby'))));
  }

  function openMenu() {
    const M = mod();
    sheet((close) => h('div.menu', null,
      h('button.btn.secondary', { onclick: () => { close(); kit.showTutorial(M || byId[R.lobby.gameId], { cls: 'tv' }); } }, 'How to play'),
      h('div.opt', null, h('span.opt-label', null, 'Turn timer'),
        h('div.seg', null, [0, 30, 60, 90].map((s) => h('button' + (R.settings.timer === s ? '.on' : ''), {
          onclick: () => { setTimer(s); close(); },
        }, s ? s + 's' : 'Off')))),
      h('button.btn.secondary', { onclick: () => { navigator.clipboard?.writeText(joinUrl()).then(() => toast('Join link copied')).catch(() => toast(joinUrl())); } }, 'Copy join link'),
      R.game ? h('button.btn.secondary', { onclick: async () => { close(); if (await confirmSheet({ title: 'End this game?', body: 'Everyone goes back to the lobby. Scores are lost.', yes: 'End game', danger: true })) backToLobby(); } }, 'End game → lobby') : null,
      h('button.btn.danger', { onclick: async () => { close(); if (await confirmSheet({ title: 'Start a new room?', body: 'Everyone will need the new code to join.', yes: 'New room', danger: true })) { localStorage.removeItem(STORE_KEY); C.deleteKeyPair('host:' + R.code); location.reload(); } } }, 'New room')),
    { title: `Room ${R.code}` });
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input,textarea,.sheet')) return;
    const G = R.game, M = mod();
    if (e.key === ' ' && G && M && !G.over) {
      const a = (M.hostActions?.(M.publicView(G.state), ui) || []).find((x) => x.primary && !x.reason);
      if (a) { e.preventDefault(); a.pid ? actFor(a.pid, a.intent) : hostAct(a.intent); }
    } else if ((e.key === 'u' || e.key === 'U') && !e.metaKey && !e.ctrlKey) undo();
    else if (e.key === 'f' || e.key === 'F') fullscreen();
  });

  // ---------- go ----------
  for (const p of R.roster) seen[p.pid] = 0;
  onlineSig = R.roster.map(() => 0).join('');
  if (R.game) { runDue(); for (const s of R.game.sched) setTimeout(runDue, Math.max(0, s.at - Date.now()) + 5); }
  bump();

  if (DEV) {
    window.__gn = {
      role: 'host',
      get R() { return R; },
      rng, net, undo, hostAct, actFor, startGame, backToLobby, approve, deny, setController,
      get forged() { return forged; },
      privCache, seen,
    };
  }
}

function defaults(M) {
  return Object.fromEntries((M.options || []).map((o) => [o.id, o.default]));
}
