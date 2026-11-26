// Phone engine: join/rejoin, encrypted intents with retry, state + private-view handling.
import { V, T, DEV, isLocalMode, randomId, cleanName, urlWith } from './proto.js';
import { createNet } from './net.js';
import * as C from './crypto.js';
import * as kit from './ui/index.js';
import { loadGames } from '../games/registry.js';
import { watchUpdates } from './update.js';
import * as Ctl from './controller.js';

const { h, clear, toast, sheet, confirmSheet } = kit;

export async function startPlayer(root, code) {
  document.body.className = 'phone';
  // Local test mode: one player per tab. Online: one player per browser.
  const store = isLocalMode() ? sessionStorage : localStorage;
  const games = await loadGames({ dev: true }); // the host decides what's visible; phones can render all
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));

  let pid = store.getItem('gn.pid');
  if (!pid) { pid = randomId(12); store.setItem('gn.pid', pid); }
  let name = store.getItem('gn.name') || '';

  let net = null, kp = null;
  let mode = 'form'; // form | joining | in | kicked | denied | approve-wait | replaced | version
  let S = null;      // last state message
  let renderedKey = '';
  let priv = null, privSeq = -1;
  let sharedKey = null, hostX = null;
  let lastHeard = 0, lastNeed = 0;
  let lastFx = 0;
  let wasActive = false;
  let timerDeadline = null;
  let phoneLocal = {}, localFor = null;
  const pending = new Map();
  let updateBuild = null;
  watchUpdates((b) => { updateBuild = b; paintBars(); });

  history.replaceState(null, '', urlWith('g=' + code));

  // ---------- join form ----------
  function renderForm(err) {
    mode = 'form';
    clear(root);
    const input = h('input', { type: 'text', value: name, maxlength: 18, placeholder: 'Your name', autocomplete: 'nickname', enterkeyhint: 'go', 'aria-label': 'Your name' });
    const submit = (e) => {
      e?.preventDefault();
      const n = cleanName(input.value);
      if (!n) { input.focus(); return; }
      name = n;
      store.setItem('gn.name', name);
      store.setItem('gn.room', code);
      connect();
    };
    root.append(h('div.phone-center', null,
      h('div.brand', null, h('span.brand-mark', null, '♠'), ' Game Night'),
      h('form.join-form', { onsubmit: submit },
        h('div.join-code', null, 'Room ', h('b', null, code)),
        input,
        err ? h('p.error', null, err) : null,
        h('button.btn.primary.big', { type: 'submit' }, 'Join'))));
    if (!C.hasCrypto) root.append(h('p.hint.center', null, "This browser can't join hidden-card games, but it can still play Bank."));
    setTimeout(() => input.focus(), 50);
  }

  // ---------- connection ----------
  async function connect() {
    mode = 'joining';
    render(true);
    if (!kp && C.hasCrypto) kp = await C.loadKeyPair('player:' + pid);
    if (!net) {
      net = createNet(code, { onMessage, onStatus: () => paintBars() });
      setInterval(() => hello(), T.HELLO_EVERY);
      setInterval(paintBars, 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) hello(true); });
      addEventListener('online', () => hello(true));
      addEventListener('pagehide', () => { if (mode === 'in') net.send({ t: 'bye', v: V, room: code, pid }); });
    }
    hello(true);
  }

  function privStale() {
    const me = meIn();
    return !!(S?.game?.hasPriv && me && !me.spectator && (me.pseq || 0) > privSeq);
  }
  function hello(need = false) {
    if (!net || mode === 'form' || mode === 'version' || mode === 'replaced') return;
    net.send({ t: 'hello', v: V, room: code, pid, name, key: kp?.publicJwk || null, need: !!(need || !S || privStale()), waiting: mode === 'approve-wait' || mode === 'denied' });
  }
  function requestNeed() {
    if (Date.now() - lastNeed < 1500) return;
    lastNeed = Date.now();
    hello(true);
  }

  function meIn() { return S?.roster?.find((p) => p.pid === pid) || null; }
  const nameOf = (id) => S?.roster?.find((p) => p.pid === id)?.name || 'Someone';

  async function onMessage(m) {
    if (m.to && m.to !== pid) return;
    if (m.t === 'state') {
      if (m.v !== V) { mode = 'version'; render(true); return; }
      lastHeard = Date.now();
      const firstState = !S;
      S = m;
      if (m.hostKey && kp && m.hostKey.x !== hostX) {
        hostX = m.hostKey.x;
        sharedKey = C.deriveShared(kp.privateKey, m.hostKey).catch(() => null);
      }
      const me = meIn();
      if (me) { if (mode === 'joining') mode = 'in'; }
      else if (mode === 'in') { mode = 'joining'; requestNeed(); }
      else if (mode === 'joining' || mode === 'approve-wait') requestNeed();
      if (privStale()) requestNeed();
      timerDeadline = m.game?.timerLeft != null ? Date.now() + m.game.timerLeft : null;
      if (m.game?.id !== localFor) { localFor = m.game?.id ?? null; phoneLocal = {}; }
      if (!m.game) { priv = null; }
      handleFx(firstState);
      handleTurnHaptic();
      render();
    } else if (m.v !== V) {
      return;
    } else if (m.t === 'priv') {
      lastHeard = Date.now();
      if (!sharedKey) { requestNeed(); return; }
      try {
        const k = await sharedKey;
        const { pv } = await C.unseal(k, m.iv, m.ct);
        if (m.seq >= privSeq) { priv = pv; privSeq = m.seq; render(); }
      } catch { requestNeed(); }
    } else if (m.t === 'ack') {
      const p = pending.get(String(m.n));
      if (p) { clearTimeout(p.timer); pending.delete(String(m.n)); p.res({ ok: !!m.ok, err: m.err || null }); }
    } else if (m.t === 'notice') {
      if (m.kx && m.kx !== (kp ? kp.publicJwk.x : 'plain')) return; // meant for another device with this pid
      if (mode === 'replaced') return;
      if (m.kind === 'kicked') { mode = 'kicked'; store.removeItem('gn.room'); }
      else if (m.kind === 'approve-wait') mode = 'approve-wait';
      else if (m.kind === 'denied') mode = 'denied';
      else if (m.kind === 'replaced') mode = 'replaced';
      else if (m.kind === 'controller') { toast('🎮 You have the remote now'); kit.vibrate([40, 30, 40]); }
      else if (m.kind === 'approved') {
        if (m.adopt && m.adopt !== pid) {
          // The host gave this device an existing seat: take over its pid, keep our key.
          const oldPid = pid;
          pid = m.adopt;
          store.setItem('gn.pid', pid);
          if (m.name) { name = cleanName(m.name) || name; store.setItem('gn.name', name); }
          if (kp) await C.saveKeyPair('player:' + pid, kp, 'player:' + oldPid);
        }
        mode = 'in'; lastNeed = 0; requestNeed();
      }
      render(true);
    }
  }

  function handleFx(first) {
    const fx = S?.game?.fx || [];
    const maxId = fx.reduce((a, f) => Math.max(a, f.id), lastFx);
    if (first || !S.game) { lastFx = maxId; return; } // never replay old effects after a (re)join
    const M = byId[S.game.id];
    const me = meInfo();
    for (const f of fx) {
      if (f.id <= lastFx) continue;
      if (f.kind === '@undo') toast('The host undid the last move');
      else if (f.kind === '@start') { phoneLocal = {}; kit.closeSheets(); kit.vibrate(40); }
      else if (f.kind === '@over') kit.vibrate([80, 60, 80]);
      else { try { M?.phone?.fx?.(f.kind, f.data, ui, me); } catch (e) { console.error(e); } }
    }
    lastFx = maxId;
  }

  function handleTurnHaptic() {
    const active = !!S?.game?.active?.includes(pid) && !S.game.over;
    if (active && !wasActive) kit.vibrate([60, 40, 60]);
    wasActive = active;
  }

  // ---------- intents ----------
  async function send(intent) {
    if (!S || !net) return { ok: false, err: 'Not connected yet' };
    const n = randomId(10);
    let msg;
    if (kp) {
      const k = sharedKey && await sharedKey;
      if (!k) { requestNeed(); return { ok: false, err: 'Still connecting…' }; }
      msg = { t: 'act', v: V, room: code, pid, ...(await C.seal(k, { n, intent })) };
    } else {
      msg = { t: 'act', v: V, room: code, pid, plain: { n, intent } };
    }
    return new Promise((res) => {
      const p = { res, timer: null, tries: 0 };
      const fire = () => {
        if (p.tries++ >= T.ACT_TRIES) { pending.delete(n); res({ ok: false, err: 'No response from the host' }); return; }
        net.send(msg);
        p.timer = setTimeout(fire, T.ACT_RETRY);
      };
      pending.set(n, p);
      fire();
    });
  }

  const isOnline = (id) => !!S?.roster?.find((p) => p.pid === id)?.on;
  const ctl = (op, args = {}) => ui.send({ type: '@ctl', op, ...args });
  const ctlCtx = () => ({ S, pid, byId, nameOf, ctl });
  const isController = () => !!S && S.controller === pid;

  const ui = {
    kit,
    get room() { return code; },
    name: nameOf,
    isOnline,
    get controller() { return S?.controller || null; },
    get roster() { return S?.roster || []; },
    get local() { return phoneLocal; },
    vibrate: kit.vibrate,
    async send(intent) {
      const r = await send(intent);
      if (!r.ok && r.err) toast(r.err, { kind: 'bad' });
      return r;
    },
  };

  function meInfo() {
    const me = meIn();
    const g = S?.game;
    return {
      pid, name,
      seat: me ? me.seat : null,
      isActive: !!g?.active?.includes(pid),
      isSpectator: !g || !me || !!me.spectator,
      isController: isController(),
    };
  }

  // ---------- rendering ----------
  let bars;
  function render(force = false) {
    const key = [mode, S?.ver, privSeq, JSON.stringify(priv)?.length].join('|');
    if (!force && key === renderedKey) return;
    renderedKey = key;
    const scrollY = window.scrollY;
    clear(root);
    bars = h('div.bars');
    root.append(topbar(), bars);
    const body = h('main.phone-body');
    root.append(body);
    if (mode === 'version') body.append(center('🔄', 'Refresh to update', 'The host is running a newer version.', h('button.btn.primary.big', { onclick: () => location.reload() }, 'Refresh')));
    else if (mode === 'kicked') body.append(center('👋', 'You were removed from the room', null, h('button.btn.primary.big', { onclick: () => { store.setItem('gn.room', code); mode = 'joining'; S = null; render(true); hello(true); } }, 'Rejoin')));
    else if (mode === 'denied') body.append(center('🔒', "The host didn't approve this device", 'Ask the host, then try again.', h('button.btn.primary.big', { onclick: () => { mode = 'joining'; render(true); hello(true); } }, 'Try again')));
    else if (mode === 'replaced') body.append(center('📱', 'This seat moved to another device', 'Someone reconnected as you from a different phone.', h('button.btn.primary.big', { onclick: () => { store.removeItem('gn.pid'); store.removeItem('gn.room'); location.reload(); } }, 'Join as someone new')));
    else if (mode === 'approve-wait') body.append(center('📱', 'New device', 'Waiting for the host to approve this phone on the TV…', kit.waiting('')));
    else if (mode === 'joining' || !S) body.append(center('♠', `Joining room ${code}…`, 'Make sure the host screen is open.', kit.waiting('')));
    else if (!S.game) renderLobby(body);
    else renderGame(body);
    paintBars();
    if (scrollY) window.scrollTo(0, scrollY);
  }

  function center(icon, title, sub, ...extra) {
    return h('div.phone-center', null, h('div.big-icon', null, icon), h('h2', null, title), sub ? h('p.hint', null, sub) : null, extra);
  }

  function topbar() {
    const g = S?.game && byId[S.game.id];
    return h('header.phone-top', null,
      h('span.pt-room', null, code),
      h('span.pt-title', null, g ? g.name : 'Game Night'),
      isController() && mode === 'in' ? h('span.tag.remote', { title: 'You have the remote' }, '🎮') : null,
      h('span.timer', { id: 'phone-timer' }),
      h('span.dot-online', { id: 'phone-conn' }),
      mode !== 'form' ? h('button.icon-btn', { 'aria-label': 'Menu', onclick: openMenu }, '☰') : null);
  }

  function paintBars() {
    if (!bars) return;
    const silent = mode !== 'form' && net && Date.now() - lastHeard > T.RECONNECT_MS;
    clear(bars);
    if (silent && mode !== 'version') bars.append(h('div.reconnecting', { role: 'status' }, 'Reconnecting…'));
    if (updateBuild && mode !== 'version') bars.append(h('div.update-bar', { role: 'status' },
      h('span', null, 'A new version is ready'),
      h('button.btn.sm.primary', { onclick: () => location.reload() }, 'Update')));
    const dot = document.getElementById('phone-conn');
    if (dot) dot.classList.toggle('on', !silent && !!S);
    const t = document.getElementById('phone-timer');
    if (t) {
      const left = timerDeadline ? Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000)) : null;
      t.textContent = left == null ? '' : `⏱ ${left}s`;
      t.classList.toggle('low', left != null && left <= 5);
    }
  }

  function renderLobby(body) {
    if (isController()) { body.append(Ctl.lobbyPanel(ctlCtx())); return; }
    const me = meIn();
    const M = byId[S.lobby?.gameId];
    body.append(h('div.phone-lobby', null,
      h('div.youre-in', null, h('div.big-icon', null, '✓'), h('h2', null, "You're in, ", h('span', null, me?.name || name), '!'),
        h('p.hint', null, me?.sitOut ? "You're sitting out the next game." : S.controller ? `🎮 ${nameOf(S.controller)} has the remote and will start a game soon.` : 'Watch the TV. A game will start soon.')),
      M ? h('div.card.game-preview', null,
        h('div.gc-label', null, 'Up next'),
        h('div.gc-name', null, M.name), h('div.gc-tag', null, M.tagline || ''),
        h('button.btn.secondary', { onclick: () => kit.showTutorial(M) }, 'How to play')) : null,
      h('h3', null, `Who's here (${S.roster.length})`),
      kit.scoreboard(S.roster.map((p) => ({ pid: p.pid, name: p.name, on: p.on, dim: p.sitOut, status: p.sitOut ? 'sitting out' : `seat ${p.seat + 1}` })), { compact: true, mePid: pid })));
  }

  function renderGame(body) {
    const g = S.game, M = byId[g.id];
    if (!M) { body.append(center('🔄', 'Refresh to update', 'This phone does not have that game yet.', h('button.btn.primary.big', { onclick: () => location.reload() }, 'Refresh'))); return; }
    const me = meInfo();
    if (isController()) { const pc = Ctl.pendingCards(ctlCtx()); if (pc) body.append(pc); }
    if (g.over) {
      body.append(h('div.phone-results', null,
        h('h2.results-title', null, kit.winnerLine(g.results, nameOf)),
        kit.podium(g.results, nameOf),
        isController() ? Ctl.resultsControls(ctlCtx())
          : h('p.hint.center', null, `Waiting for ${nameOf(S.controller)} to play again or go back to the lobby.`)));
      return;
    }
    if (g.hasPriv && !kp && !me.isSpectator) {
      body.append(center('🔒', "This browser can't join hidden-card games", 'Try Safari or Chrome, up to date.'));
      return;
    }
    const stage = h('div.phone-stage');
    if (me.isSpectator) body.append(kit.spectatorBanner());
    body.append(stage);
    try { M.phone.render(stage, g.pub, me.isSpectator ? null : priv, me, ui); }
    catch (e) { console.error(e); stage.append(h('p.error', null, 'Render error: ' + e.message)); }
    if (isController()) { body.classList.add('has-ctl-bar'); body.append(Ctl.gameBar(ctlCtx(), M, g.pub, ui)); }
  }

  function openMenu() {
    const M = (S?.game && byId[S.game.id]) || byId[S?.lobby?.gameId];
    sheet((close) => h('div.menu', null,
      M ? h('button.btn.secondary', { onclick: () => { close(); kit.showTutorial(M); } }, `How to play ${M.name}`) : null,
      h('button.btn.secondary', { onclick: () => { close(); changeName(); } }, 'Change name'),
      isController() ? h('button.btn.secondary', { onclick: () => { close(); Ctl.handoffSheet(ctlCtx()); } }, '🎮 Hand off the remote') : null,
      isController() && !S.game ? Ctl.timerRow(ctlCtx(), close) : null,
      S && S.controller && !isController() && !isOnline(S.controller) ? h('button.btn.secondary', { onclick: () => { close(); ctl('claim'); } }, `🎮 Take the remote (${nameOf(S.controller)} is offline)`) : null,
      S && !S.controller ? h('button.btn.secondary', { onclick: () => { close(); ctl('claim'); } }, '🎮 Take the remote') : null,
      h('button.btn.danger', { onclick: async () => {
        close();
        if (!(await confirmSheet({ title: 'Leave the room?', body: 'You can rejoin with the code later.', yes: 'Leave', danger: true }))) return;
        if (S) await send({ type: '@leave-room' });
        store.removeItem('gn.room');
        location.href = urlWith('');
      } }, 'Leave room')),
    { title: `Room ${code}` });
  }

  function changeName() {
    const input = h('input', { type: 'text', value: name, maxlength: 18, 'aria-label': 'New name' });
    const close = sheet((close) => h('form.join-form', { onsubmit: (e) => {
      e.preventDefault();
      const n = cleanName(input.value);
      if (!n) return;
      name = n; store.setItem('gn.name', n); hello(true); close(); toast('Name updated');
    } }, input, h('button.btn.primary.big', { type: 'submit' }, 'Save')), { title: 'Change name' });
    setTimeout(() => input.focus(), 50);
    void close;
  }

  // ---------- go ----------
  if (name && store.getItem('gn.room') === code) connect(); // refresh / rejoin keeps the seat
  else renderForm();

  if (DEV) {
    window.__gn = {
      role: 'player', get pid() { return pid; },
      get S() { return S; }, get priv() { return priv; }, get mode() { return mode; },
      send, get net() { return net; },
      // Try to decrypt any captured envelope with this phone's key (tests prove it fails for others' messages).
      async tryOpen(m) { try { return await C.unseal(await sharedKey, m.iv, m.ct); } catch { return null; } },
    };
  }
}
