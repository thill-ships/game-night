// Engine tests via the dev-only sample game: private views, encryption, forged
// intents, new-device approval, simultaneous reveal, constrained multi-select.
const { test, expect } = require('@playwright/test');
const { openHost, openPlayer, gameState, watchErrors, noSidewaysScroll } = require('./helpers');

async function tapCard(page, n) { await page.locator('.hand-card', { hasText: new RegExp(`^${n}$`) }).first().click(); }

test('hidden hands, encryption, simultaneous reveal, keep 2 of 3', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });

  // A silent observer records every raw message on the room channel.
  const spy = await context.newPage();
  await spy.goto('/index.html');
  await spy.evaluate((c) => { window.raw = []; const bc = new BroadcastChannel('gn-' + c.toLowerCase()); bc.onmessage = (e) => window.raw.push(e.data); }, code);

  const ps = [];
  for (const n of ['Ana', 'Ben', 'Cy']) ps.push(await openPlayer(context, code, n, { errors }));
  const [a, b, c] = ps;
  await host.locator('.game-card', { hasText: 'Card Test' }).click();
  await host.getByRole('button', { name: 'Start Card Test' }).click();
  await expect(host.locator('.sample-tv')).toBeVisible();

  // Each phone receives exactly its own hand.
  let s = await gameState(host);
  for (const p of ps) {
    await expect.poll(() => p.page.evaluate(() => window.__gn.priv && window.__gn.priv.hand)).toEqual(s.hands[p.pid]);
    await expect(p.page.locator('.hand-card')).toHaveCount(5);
  }

  // Simultaneous pick: nobody's choice shows until the last one is in.
  const pick = async (p, card, last = false) => {
    await tapCard(p.page, card);
    await p.page.getByRole('button', { name: /Play this card/ }).click();
    await p.page.getByRole('button', { name: 'Play it' }).click();
    if (!last) await expect(p.page.locator('.waiting')).toContainText('Waiting for others');
  };
  const aCard = s.hands[a.pid][2], bCard = s.hands[b.pid][0], cCard = s.hands[c.pid][4];
  await pick(a, aCard);
  await pick(b, bCard);
  await expect(host.locator('.waiting-count')).toHaveText('2 of 3 ready');
  await expect(c.page.locator('.hand-card')).toHaveCount(5);
  s = await gameState(host);
  expect(s.board).toEqual([]);
  const pubNow = await c.page.evaluate(() => window.__gn.S.game.pub);
  expect(JSON.stringify(pubNow)).not.toContain('picks');
  expect(pubNow.board).toEqual([]);
  await pick(c, cCard, true);
  await expect.poll(async () => (await gameState(host)).board.map((x) => x.card)).toEqual([aCard, bCard, cCard]);
  await expect(host.locator('.bcard')).toHaveCount(3);

  // Keep at least 2 of 3: the button explains why it's locked, and the host enforces it too.
  s = await gameState(host);
  const offer = s.offers[a.pid];
  await expect(a.page.locator('.hand-card').first()).toBeVisible();
  await tapCard(a.page, offer[0]);
  const keepBtn = a.page.getByRole('button', { name: /Keep these/ });
  await expect(keepBtn).toBeDisabled();
  await expect(keepBtn).toContainText('Keep at least 2 of 3');
  expect(await b.page.evaluate((o) => window.__gn.send({ type: 'keep', cards: [o[0]] }), s.offers[b.pid])).toEqual({ ok: false, err: 'Keep at least 2 of the 3' });
  await tapCard(a.page, offer[1]);
  await expect(keepBtn).toBeEnabled();
  await keepBtn.click();
  await expect.poll(async () => (await gameState(host)).kept[a.pid]).toEqual([offer[0], offer[1]]);

  // Raw traffic: no hands or offers in plaintext; private messages are only ciphertext.
  const raw = await spy.evaluate(() => window.raw);
  expect(raw.length).toBeGreaterThan(5);
  const privs = raw.filter((m) => m.t === 'priv');
  expect(privs.length).toBeGreaterThanOrEqual(3);
  for (const m of raw) {
    const js = JSON.stringify(m);
    expect(js).not.toMatch(/"(hands?|offers?|picks?|kept|deck)":/);
    if (m.t === 'priv') expect(Object.keys(m).sort()).toEqual(['ct', 'iv', 'room', 'seq', 't', 'to', 'v', 'ver']);
    if (m.t === 'act') expect(m.plain).toBeUndefined();
  }
  // A phone can't open another player's private message.
  const forBen = privs.filter((m) => m.to === b.pid);
  expect(await a.page.evaluate((m) => window.__gn.tryOpen(m), forBen.at(-1))).toBeNull();
  expect(await b.page.evaluate((m) => window.__gn.tryOpen(m), forBen.at(-1))).not.toBeNull();

  for (const p of ps) await noSidewaysScroll(p.page);
  expect(errors).toEqual([]);
});

test('forged intents are rejected and a new device must be approved', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const a = await openPlayer(context, code, 'Ana', { errors });
  const b = await openPlayer(context, code, 'Ben', { errors });
  await host.locator('.game-card', { hasText: 'Card Test' }).click();
  await host.getByRole('button', { name: 'Start Card Test' }).click();
  await expect.poll(() => a.page.evaluate(() => !!window.__gn.priv)).toBe(true);
  const handA = (await gameState(host)).hands[a.pid];

  // Ben forges an intent claiming to be Ana, sealed with Ben's own key.
  const forgedBefore = await host.evaluate(() => window.__gn.forged);
  await b.page.evaluate(async ({ apid, card, code }) => {
    const g = window.__gn;
    const real = { n: 'x1', intent: { type: 'pick', card } };
    // Reuse the phone's own encryption by sending a normal act, then rewrite the pid.
    const orig = g.net.send.bind(g.net);
    g.net.send = (m) => orig(m.t === 'act' ? { ...m, pid: apid } : m);
    g.send(real.intent);
    await new Promise((r) => setTimeout(r, 1500));
    g.net.send = orig;
    void code;
  }, { apid: a.pid, card: handA[0], code });
  await expect.poll(() => host.evaluate(() => window.__gn.forged)).toBeGreaterThan(forgedBefore);
  expect((await gameState(host)).picks[a.pid]).toBeUndefined();

  // New device for Ana: same pid, fresh key → the TV asks before handing over the seat.
  await a.page.evaluate((pid) => new Promise((res) => {
    const r = indexedDB.open('gn-keys', 1);
    r.onsuccess = () => { const tx = r.result.transaction('keys', 'readwrite'); tx.objectStore('keys').delete('player:' + pid); tx.oncomplete = res; };
  }), a.pid);
  const a2 = await context.newPage();
  watchErrors(a2, errors);
  await a2.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await a2.setViewportSize({ width: 390, height: 844 });
  await a2.addInitScript(({ pid, code }) => { sessionStorage.setItem('gn.pid', pid); sessionStorage.setItem('gn.name', 'Ana'); sessionStorage.setItem('gn.room', code); }, { pid: a.pid, code });
  await a2.goto(`/?g=${code}&dev`);
  await expect(a2.getByText('Waiting for the host to approve this phone')).toBeVisible();
  await expect(host.locator('.pending-row')).toContainText('Ana is trying to reconnect from a new device. Allow?');
  // Unapproved device can't act.
  const r = await a2.evaluate((card) => window.__gn.send({ type: 'pick', card }), handA[0]);
  expect(r.ok).toBe(false);
  expect((await gameState(host)).picks[a.pid]).toBeUndefined();

  await host.locator('.pending-row').getByRole('button', { name: 'Allow' }).click();
  await expect(host.locator('.pending-row')).toHaveCount(0);
  await expect(a2.locator('.hand-card')).toHaveCount(5);
  expect(await a2.evaluate(() => window.__gn.priv.hand)).toEqual(handA);
  // The approved device plays; the old one is now locked out.
  expect(await a2.evaluate((card) => window.__gn.send({ type: 'pick', card }), handA[1])).toEqual({ ok: true, err: null });
  expect((await gameState(host)).picks[a.pid]).toBe(handA[1]);
  // The old device is told its seat moved, and the TV doesn't nag about it.
  await expect(a.page.getByText('This seat moved to another device')).toBeVisible();
  await expect(host.locator('.pending-row')).toHaveCount(0);
  await expect(a2.locator('.waiting')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a phone that lost its storage can reclaim its seat by name (host approves)', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const a = await openPlayer(context, code, 'Ana', { errors });
  const b = await openPlayer(context, code, 'Ben', { errors });
  const c = await openPlayer(context, code, 'Cy', { errors });
  await host.locator('.game-card', { hasText: 'Card Test' }).click();
  await host.getByRole('button', { name: 'Start Card Test' }).click();
  await expect(a.page.locator('.hand-card')).toHaveCount(5);
  const handA = (await gameState(host)).hands[a.pid];

  // Ana's phone goes away (tab closed → bye → offline) and comes back with no storage at all.
  await a.page.close();
  await expect.poll(() => host.evaluate((pid) => window.__gn.R.roster.length && !window.__gn.seen[pid], a.pid)).toBe(true);
  const fresh = await openPlayerRaw(context, code, 'ana', errors);
  await expect(fresh.getByText('Waiting for the host to approve this phone')).toBeVisible();
  await expect(host.locator('.pending-row')).toContainText('Ana is trying to reconnect from a new device');
  await host.locator('.pending-row').getByRole('button', { name: 'Allow' }).click();
  await expect(fresh.locator('.hand-card')).toHaveCount(5);
  expect(await fresh.evaluate(() => window.__gn.pid)).toBe(a.pid);
  expect(await fresh.evaluate(() => window.__gn.priv.hand)).toEqual(handA);
  await expect(host.locator('.roster-row, .sb-row')).toHaveCount(3);
  // Refreshing the adopted phone keeps the seat without asking again.
  await fresh.reload();
  await expect(fresh.locator('.hand-card')).toHaveCount(5);
  await expect(host.locator('.pending-row')).toHaveCount(0);

  // Same name but the host says it's a different person → joins as a new player.
  await c.page.close();
  await expect.poll(() => host.evaluate((pid) => !window.__gn.seen[pid], c.pid)).toBe(true);
  const other = await openPlayerRaw(context, code, 'Cy', errors);
  await host.locator('.pending-row').getByRole('button', { name: 'No, new player' }).click();
  await expect(other.locator('.spectator-banner')).toBeVisible();
  expect((await host.evaluate(() => window.__gn.R.roster.map((p) => p.name)))).toEqual(['Ana', 'Ben', 'Cy', 'Cy 2']);
  void b;
  expect(errors).toEqual([]);
});

async function openPlayerRaw(context, code, name, errors) {
  const page = await context.newPage();
  watchErrors(page, errors);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?g=${code}&dev`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  return page;
}

test('spectators get no private data; dev game hidden without ?dev', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const ps = [];
  for (const n of ['Ana', 'Ben', 'Cy']) ps.push(await openPlayer(context, code, n, { errors }));
  await host.locator('.roster-row', { hasText: 'Cy' }).getByRole('button', { name: 'Playing' }).click();
  await host.locator('.game-card', { hasText: 'Card Test' }).click();
  await host.getByRole('button', { name: 'Start Card Test' }).click();
  await expect(ps[2].page.locator('.spectator-banner')).toBeVisible();
  await expect(ps[0].page.locator('.hand-card')).toHaveCount(5);
  expect(await ps[2].page.evaluate(() => window.__gn.priv)).toBeNull();
  await expect(ps[2].page.locator('.hand-card')).toHaveCount(0);

  const plain = await context.newPage();
  await plain.goto('/index.html');
  await plain.evaluate(() => localStorage.clear());
  await plain.goto('/?host');
  await expect(plain.locator('.game-card')).toHaveCount(1);
  await expect(plain.locator('.game-card')).toContainText('Bank');
  expect(errors).toEqual([]);
});
