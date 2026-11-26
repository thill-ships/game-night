// The remote: the first phone to join runs the night, so nobody touches the TV.
// Also: Bank's Roll button is the biggest thing on the roller's phone, and the update prompt.
const { test, expect } = require('@playwright/test');
const { openHost, openPlayer, R, gameState, noSidewaysScroll } = require('./helpers');

const st = (host) => gameState(host);
const rig = (host, faces) => host.evaluate((f) => window.__gn.rng.rigDice(f), faces);

test('the first phone runs the whole night from the remote', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const a = await openPlayer(context, code, 'Ana', { errors });
  const b = await openPlayer(context, code, 'Ben', { errors });
  const c = await openPlayer(context, code, 'Cy', { errors });
  expect((await R(host)).controller).toBe(a.pid);
  await expect(host.locator('.roster-row', { hasText: 'Ana' }).locator('.tag.remote')).toBeVisible();
  await expect(b.page.locator('.youre-in')).toContainText('Ana has the remote');

  // Only the remote can change things.
  expect(await b.page.evaluate(() => window.__gn.send({ type: '@ctl', op: 'start' }))).toEqual({ ok: false, err: 'Only Ana can do that (they have the remote)' });

  // Lobby from the phone: options, seat order, sit out, start.
  await a.page.locator('.opt', { hasText: 'Rounds' }).getByRole('button', { name: '10', exact: true }).click();
  await expect.poll(async () => (await R(host)).lobby.options.rounds).toBe(10);
  await a.page.getByRole('button', { name: 'Move Cy up' }).click();
  await expect.poll(async () => (await R(host)).roster.map((p) => p.name)).toEqual(['Ana', 'Cy', 'Ben']);
  await a.page.locator('.roster-row', { hasText: 'Cy' }).getByRole('button', { name: 'Playing' }).click();
  await expect.poll(async () => (await R(host)).roster.find((p) => p.pid === c.pid).sitOut).toBe(true);
  await noSidewaysScroll(a.page);
  await a.page.getByRole('button', { name: /Start Bank/ }).click();
  await expect(host.locator('.bank-tv')).toBeVisible();
  expect((await st(host)).players.map((p) => p.pid)).toEqual([a.pid, b.pid]);
  await expect(c.page.locator('.spectator-banner')).toBeVisible();

  // Roll is the biggest thing on the roller's phone; Bank is smaller.
  await rig(host, [2, 3]);
  const roll = a.page.locator('.roll-btn'), bank = a.page.locator('.bank-btn');
  await expect(roll).toBeVisible();
  const rb = await roll.boundingBox(), bb = await bank.boundingBox();
  expect(rb.height).toBeGreaterThan(bb.height * 1.8);
  expect(rb.width).toBeGreaterThanOrEqual(bb.width);
  await roll.click();
  await expect.poll(async () => (await st(host)).rollCount).toBe(1);

  // Both bank → round over → "Next round" is the big button on the remote.
  await a.page.locator('.bank-btn').click();
  await b.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
  await expect(b.page.locator('.bp-round')).toContainText('Waiting for Ana to start the next round');
  await a.page.locator('.ctl-bar').getByRole('button', { name: 'Next round' }).click();
  await expect.poll(async () => (await st(host)).round).toBe(2);

  // Undo from the remote sheet.
  await a.page.getByRole('button', { name: 'Remote controls' }).click();
  await a.page.getByRole('button', { name: '↶ Undo last move' }).click();
  await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
  await a.page.locator('.ctl-bar').getByRole('button', { name: 'Next round' }).click();
  await expect.poll(async () => (await st(host)).round).toBe(2);

  // Finish the game from the remote (bank for both through the remote's actFor), then results.
  for (let r = 2; r <= 10; r++) {
    await rig(host, [1, 2]);
    expect((await a.page.evaluate(() => window.__gn.send({ type: '@ctl', op: 'hostAct', intent: { type: 'roll' } }))).ok).toBe(true);
    await expect.poll(async () => (await st(host)).rollCount).toBe(1);
    for (const pid of [a.pid, b.pid]) expect((await a.page.evaluate((p) => window.__gn.send({ type: '@ctl', op: 'actFor', pid: p, intent: { type: 'bank' } }), pid)).ok).toBe(true);
    await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
    await a.page.locator('.ctl-bar').getByRole('button', { name: /Next round|See results/ }).click();
    await expect.poll(async () => { const s = await st(host); return s.phase === 'over' || s.round === r + 1; }).toBe(true);
  }
  await expect(a.page.locator('.ctl-results')).toBeVisible();
  await expect(b.page.locator('.phone-results')).toContainText('Waiting for Ana');
  await a.page.getByRole('button', { name: 'Play again' }).click();
  await expect.poll(async () => (await st(host))?.round).toBe(1);
  await a.page.getByRole('button', { name: 'Remote controls' }).click();
  await a.page.getByRole('button', { name: 'End game → lobby' }).click();
  await a.page.getByRole('button', { name: 'End game', exact: true }).click();
  await expect(a.page.locator('.ctl-lobby')).toBeVisible();
  await expect(host.locator('.lobby')).toBeVisible();

  // Hand off the remote.
  await a.page.getByRole('button', { name: 'Menu' }).click();
  await a.page.getByRole('button', { name: '🎮 Hand off the remote' }).click();
  await a.page.locator('.sheet').getByRole('button', { name: /Ben/ }).click();
  await expect(b.page.locator('.ctl-lobby')).toBeVisible();
  await expect(a.page.locator('.youre-in')).toContainText('Ben has the remote');

  // If the remote's phone goes away, someone else can take it.
  await b.page.close();
  await expect.poll(() => host.evaluate((pid) => !window.__gn.seen[pid], b.pid)).toBe(true);
  await c.page.getByRole('button', { name: 'Menu' }).click();
  await c.page.getByRole('button', { name: /Take the remote/ }).click();
  await expect(c.page.locator('.ctl-lobby')).toBeVisible();
  expect((await R(host)).controller).toBe(c.pid);
  expect(errors).toEqual([]);
});

test('the remote approves a new device', async ({ context }) => {
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const a = await openPlayer(context, code, 'Ana', { errors });
  const b = await openPlayer(context, code, 'Ben', { errors });
  await b.page.close();
  await expect.poll(() => host.evaluate((pid) => !window.__gn.seen[pid], b.pid)).toBe(true);
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: 390, height: 844 });
  await fresh.goto(`/?g=${code}&dev&local`);
  await fresh.getByLabel('Your name').fill('Ben');
  await fresh.getByRole('button', { name: 'Join' }).click();
  await expect(a.page.locator('.ctl-pend')).toContainText('Ben is trying to reconnect from a new device');
  await a.page.locator('.ctl-pend').getByRole('button', { name: 'Allow' }).click();
  await expect(fresh.locator('.youre-in')).toBeVisible();
  expect(await fresh.evaluate(() => window.__gn.pid)).toBe(b.pid);
  expect(errors).toEqual([]);
});

test('phones and the TV offer the newest version', async ({ context }) => {
  // Pretend this copy is build "aaa1111" and the site now serves "bbb2222".
  await context.route(/\/engine\/version\.js$/, (r) => r.fulfill({ contentType: 'text/javascript', body: "export const BUILD = 'aaa1111';" }));
  await context.route(/\/version\.json/, (r) => r.fulfill({ contentType: 'application/json', body: '{"build":"bbb2222"}' }));
  const errors = [];
  const { page: host, code } = await openHost(context, { errors });
  const a = await openPlayer(context, code, 'Ana', { errors });
  await expect(a.page.locator('.update-bar')).toContainText('A new version is ready', { timeout: 15000 });

  // In the lobby the TV updates itself once (and doesn't loop when the copy is still old).
  await expect.poll(() => host.evaluate(() => sessionStorage.getItem('gn.reloadedFor')), { timeout: 15000 }).toBe('bbb2222');
  await host.waitForLoadState('load');
  await expect(host.locator('.lobby')).toBeVisible();
  await host.waitForTimeout(6000);
  await expect(host.locator('.lobby')).toBeVisible();
  expect(await host.evaluate(() => window.__gn.R.code)).toBe(code);

  // Tapping Update on the phone reloads it back into the same seat.
  await a.page.getByRole('button', { name: 'Update' }).click();
  await expect(a.page.locator('.ctl-lobby')).toBeVisible();
  expect(await a.page.evaluate(() => window.__gn.pid)).toBe(a.pid);
  expect(errors).toEqual([]);
});
