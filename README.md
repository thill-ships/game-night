# Game Night

A TV + phones game hub. One computer is mirrored to the TV and hosts. Everyone plays from their own phone by scanning a QR code. No accounts, no server code: it's a static site on GitHub Pages, and phones talk to the host over Supabase Realtime Broadcast.

**Games:** Bank (push-your-luck dice, 2–16 players). Plus `Card Test`, a dev-only game that exercises the engine features Bank doesn't use.

## Playing

| URL | Who | |
|---|---|---|
| `/` | anyone | Landing: host, or join with a code + name |
| `/?host` | the TV | Room lobby: QR code, players, game picker, options, Start |
| `/?g=ABCD` | phones | Join, then lobby → game → results |

- A **room** lasts the whole night; games run inside it. Players join once.
- **Seats** follow the player list order on the TV (↑ ↓ to reorder). Toggle **Playing / Sitting out** to choose who sits in when there are more players than a game allows. Everyone else watches as a spectator.
- **Host keys:** `Space` = the main action (Roll, Next round), `U` = undo, `F` = full screen. The **Menu** has How to play, a turn timer, End game, Copy join link and New room.
- If the TV refreshes or the laptop sleeps, it resumes exactly where it was (everything is saved in the host browser's `localStorage`). Use **Menu → New room** to start over.
- If a phone shows "Reconnecting…", it catches up on its own. A phone that refreshes keeps its seat.
- If a phone lost its storage (or someone picks up a different phone), they join again with **the same name**. The TV asks "*Name* is trying to reconnect from a new device. Allow?". Allow hands them their seat back; "No, new player" lets them in as someone new.

## Setup

### 1. Try it locally (no Supabase needed)

With `config.js` left blank, the site runs in **local test mode**: tabs in one browser talk via `BroadcastChannel`, and each tab is a separate player.

```bash
npm run serve
```

Open `http://localhost:8123/?host` in one tab, then open the join link shown on the TV in a few more tabs. Any static server works; there is no build step.

### 2. Connect Supabase (for real phones)

1. In your existing Supabase project: **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.
2. Paste them into `config.js`. The anon key is public by design. Only Realtime **Broadcast** is used: no tables, no auth, no database changes.

Free-tier budget: an 8-player, 2-hour night is roughly 80k messages (the free tier allows 2M/month and 200 concurrent connections).

### 3. Deploy on GitHub Pages

**Settings → Pages → Deploy from a branch →** `main` / `(root)`. The `.nojekyll` file matters: without it, Pages would drop `games/_sample`.

### Before game night (manual check)

Use the real Supabase config with 3+ real phones (iOS Safari and Android Chrome). Lock and unlock a phone mid-game, refresh the TV once, and play a few rounds.

## How it works

```
phone ──intent──▶ host engine ──▶ game.apply() ──▶ new state
                       ├──▶ publicView(state)      → broadcast to everyone
                       └──▶ privateView(state,pid) → encrypted, per player
```

- **The host is the single source of truth.** It holds the full state (deck order and hands included), is the only place randomness happens (`crypto.getRandomValues`), and validates every intent. Invalid intents are rejected with a reason the phone shows.
- **Absolute snapshots, never diffs.** Every update has a `ver`. The host rebroadcasts every 4 s, so phones that miss messages catch up. Phones only re-render when `ver` changes.
- **Encryption.** Each phone makes an ECDH P-256 key pair (non-extractable, stored in IndexedDB). Phone intents and per-player private views are AES-GCM sealed with the shared key, so a forged intent from another device doesn't decrypt. The host pins the first key it sees per player; a different key needs the host's approval. Threat model: casual peeking (devtools, reading channel traffic), not a hostile host laptop.
- **Presence.** Phones say hello every 8 s; a player is online if heard from in the last 20 s. Intents retry every 1.2 s (up to 4 sends) until acknowledged, and nonces stop double-applies.

### Messages (channel `gn-<code>`, event `m`)

| From → to | `t` | Contents |
|---|---|---|
| host → all | `state` | `ver, roster, hostKey, lobby, timer, game: { id, phase, pub, active, fx, options, seats, log, over, results, timerLeft, hasPriv }` |
| host → one | `priv` | `to, ver, seq, iv, ct` (sealed private view) |
| host → one | `ack` | `to, n, ok, err` |
| host → one | `notice` | `to, kind` (`kicked`, `approve-wait`, `approved`, `denied`, `replaced`), `kx` (which device) |
| phone → host | `hello` | `pid, name, key, need, waiting` |
| phone → host | `act` | `pid, iv, ct` (sealed `{ n, intent }`) |
| phone → host | `bye` | `pid` |

Every message carries `v` (protocol version) and `room`. A version mismatch tells phones to refresh.

## Repo layout

```
index.html            shell: loads config, libs, engine/main.js
config.js             Supabase URL + anon key (blank = local test mode)
lib/                  supabase-js 2.119.0 UMD, qrcode-generator 2.0.4 (vendored)
engine/
  main.js             routing: landing / host / player
  proto.js            protocol constants and helpers
  net.js              Supabase broadcast, or BroadcastChannel locally
  crypto.js           ECDH keys, AES-GCM envelopes, key storage
  rng.js              crypto shuffle/draw (?seed=N for a reproducible PRNG)
  room-host.js        roster, presence, key pinning, seats, lifecycle, undo, timers, persistence, TV lobby
  room-player.js      join/rejoin, intents with retry, state + private views, phone shell
  ui/                 shared UI kit (below)
  styles/base.css     felt theme, TV scaling, phone layout
games/
  registry.js         the list of games
  bank/               index.js, rules.js, tv.js, phone.js, dice.js, tutorial.js, bank.css
  _sample/            dev-only engine test game (picker shows it only with ?dev)
tests/                Playwright specs (local mode)
```

## Adding a game

Make a folder in `games/`, add one line to `games/registry.js`, and export one object. The engine owns networking, rooms, persistence, undo and timers. The game owns rules and rendering. **Rules must be pure**: no DOM, no network, all randomness through `ctx.rng`.

Use original names and art for new games (the site is public): recreate mechanics only, never rulebook text or card art.

```js
export default {
  id: 'temple', name: 'Cursed Temple', tagline: '…',
  minPlayers: 3, maxPlayers: 8, estMinutes: [20, 30],
  css: new URL('./temple.css', import.meta.url).href,   // optional
  options: [{ id: 'rounds', label: 'Rounds', type: 'choice', values: [3, 5], default: 5 },
            { id: 'x', label: 'Some rule', type: 'bool', default: true }],
  tutorial: [{ title, body, visualHtml }],                // visualHtml: static markup only

  setup({ seats, options, rng }) { return state; },       // may include hidden decks
  validate(state, pid, intent, { byHost, isOnline }) {},  // null = legal, else a short reason
  apply(state, pid, intent, ctx) {},                      // mutate the draft (engine passes a clone)
  publicView(state) {},                                   // what every screen may see
  privateView(state, pid) {},                             // this player's secrets, or null (omit if none)
  activePids(state) {},                                   // who the game is waiting on
  isOver(state) {}, results(state) {},                    // { ranking:[{pid, rank, score, detail}], columns:[{id,label}], headline? }
  undoable: true,
  hostActions(pub, ui) { return [{ label, intent, primary, reason, pid }]; },
  tv:    { header(pub), phase(pub) /* {text, kind} */, render(el, pub, ui), fx(kind, data, ui) },
  phone: { render(el, pub, priv, me, ui), fx(kind, data, ui, me) },
};
```

- **`pid` in validate/apply** is a player id, `'host'` (TV buttons) or `'system'` (scheduled steps, timeouts, `@join` / `@leave`).
- **`ctx`**: `rng` (`int, die, pick, shuffle`), `schedule(ms, intent)` for delayed system steps (dice resolve, simultaneous reveal), `fx(kind, data)` for one-shot effects the views react to, `log(text)` for the history strip, `name(pid)`, `isOnline(pid)`, `byHost`.
- **Late joiners**: the engine sends `{ type: '@join', pid }` as a system intent. Return a reason from `validate` to keep them spectating. `@leave` arrives when someone is kicked or leaves.
- **Turn timer**: on timeout the engine applies `{ type: 'timeout', pid }` as `'system'`. Each game decides what that means (Bank rolls for you).
- **Simultaneous choices**: return everyone still choosing from `activePids`, keep choices in hidden state, and only reveal in `apply` once the last one arrives. Show "X of N ready" from `publicView`.
- **Multi-step turns** (discard down to 10, keep 2 of 3): explicit sub-phases in state with their own intents, never one giant client-side intent.
- **Static data** (cards, map geometry) lives in the game folder. State refers to it by id. Keep `publicView` small (under ~20 KB).
- **`me`** on phones = `{ pid, seat, isActive, isSpectator }`. `ui.send(intent)` resolves to `{ ok, err }` and toasts errors. `ui.local` is scratch space that survives re-renders (keep in-progress selections there).

### UI kit (`ui.kit`)

TV: `qrPanel`, `joinChip`, `connBadge`, `scoreboard`, `phasePill`, `historyStrip`, `moment` ("Seven!"), `flash`, `podium` / `resultsTable`, `board({ width, height, pannable })` (an aspect-locked SVG stage).
Phone: `actionButton(label, { reason })` (disabled buttons say why), `hand({ cards, mode: 'single'|'multi', min, max, store })`, `choiceSheet`, `marketPicker`, `confirmSheet`, `waiting(text, { ready, total })`, `spectatorBanner`, `vibrate`.
Shared: `carousel` / `showTutorial`, `sheet`, `toast`, and `h()` / `s()`, which turn strings into text nodes so player names are never parsed as HTML.

## Tests

```bash
npm install
npx playwright test
```

Runs in local mode with one 1920×1080 host page (plus a 1366×768 layout run) and 390×844 phone pages. Covers Bank end to end (seats, phone and TV rolls, safe and risky banking, rejected bank while rolling, forced bust, everyone banked, undo, late joiner, kick + rejoin, TV refresh mid-roll, phone refresh, podium, play again, back to lobby, turn timer). Also covers the engine via the sample game (private views only reach their owner, no hand data in plaintext on the wire, forged intents rejected, new-device approval, reclaiming a seat after lost storage, simultaneous reveal, keep 2 of 3, spectators). Every test also checks for console errors and sideways overflow on phones.

Dev helpers: add `?dev` to any URL to expose `window.__gn` (the host's `__gn.rng.rigDice([3, 4])` forces the next roll), and `?seed=123` on the host for a reproducible PRNG.
