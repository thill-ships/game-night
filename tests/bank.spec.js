// Bank acceptance tests (local mode). Dice are forced with the host's dev rng.rig.
const { test, expect } = require('@playwright/test');
const { openHost, openPlayer, R, gameState, noSidewaysScroll } = require('./helpers');

const st = (host) => gameState(host);
const rig = (host, faces) => host.evaluate((f) => window.__gn.rng.rigDice(f), faces);
const pidOf = (p) => p.pid;
const send = (page, intent) => page.evaluate((i) => window.__gn.send(i), intent);

async function setup(context, names, errors) {
  const { page: host, code } = await openHost(context, { errors });
  const players = [];
  for (const n of names) players.push(await openPlayer(context, code, n, { errors }));
  await expect(host.locator('.roster-row')).toHaveCount(names.length);
  return { host, code, players };
}
async function setRounds(host, n) {
  await host.locator('.opt', { hasText: 'Rounds' }).getByRole('button', { name: String(n), exact: true }).click();
}
async function startBank(host) {
  await host.getByRole('button', { name: /Start Bank/ }).click();
  await expect(host.locator('.bank-tv')).toBeVisible();
}
async function waitRolls(host, n) {
  await expect.poll(async () => { const s = await st(host); return s.rolling ? -1 : s.rollCount; }).toBe(n);
}

test('seats, phone rolls, safe + risky banking, reject while rolling, undo, bust', async ({ context }) => {
  const errors = [];
  const { host, players: [a, b, c] } = await setup(context, ['Ana', 'Ben', 'Cy'], errors);

  // Reorder: move Cy up one seat → Ana, Cy, Ben
  await host.getByRole('button', { name: 'Move Cy up' }).click();
  await expect.poll(async () => (await R(host)).roster.map((p) => p.name)).toEqual(['Ana', 'Cy', 'Ben']);
  await expect(c.page.locator('.sb-row.me')).toContainText('seat 2');

  await setRounds(host, 10);
  await startBank(host);
  await expect(a.page.locator('.bank-phone')).toBeVisible();
  let s = await st(host);
  expect(s.players.map((p) => p.pid)).toEqual([a.pid, c.pid, b.pid]);
  expect(s.roller).toBe(a.pid);

  // Only the roller sees Roll; others get a rejection if they try.
  await expect(a.page.locator('.roll-btn')).toBeVisible();
  await expect(b.page.locator('.roll-btn')).toHaveCount(0);
  expect(await send(b.page, { type: 'roll' })).toEqual({ ok: false, err: "It's not your roll" });

  // Roll 1 from Ana's phone: 1+2 = 3
  await rig(host, [1, 2]);
  await a.page.locator('.roll-btn').click();
  await waitRolls(host, 1);
  expect((await st(host)).bank).toBe(3);
  await expect(host.locator('.bank-num')).toHaveText('3');

  // Bank in a safe roll (Cy)
  await c.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).players.find((p) => p.pid === c.pid).score).toBe(3);
  await expect(c.page.locator('.bank-btn')).toBeDisabled();
  await expect(c.page.locator('.bank-btn')).toContainText('Banked 3');

  // Next roller skips banked Cy → Ben. Safe 7 → +70.
  expect((await st(host)).roller).toBe(b.pid);
  await rig(host, [3, 4]);
  await b.page.locator('.roll-btn').click();
  await waitRolls(host, 2);
  expect((await st(host)).bank).toBe(73);

  // Bank is rejected while the dice are rolling.
  await rig(host, [2, 2]);
  await a.page.locator('.roll-btn').click();
  await expect.poll(async () => (await st(host)).rolling).toBe(true);
  expect(await send(b.page, { type: 'bank' })).toEqual({ ok: false, err: 'Too late to bank this roll' });
  await waitRolls(host, 3);
  expect((await st(host)).bank).toBe(77); // safe doubles count face value

  // Roll 4 is risky: doubles double the Bank.
  await rig(host, [5, 5]);
  await b.page.locator('.roll-btn').click();
  await waitRolls(host, 4);
  expect((await st(host)).bank).toBe(154);

  // Bank in a risky roll (Ben)
  await b.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).players.find((p) => p.pid === b.pid).score).toBe(154);

  // Undo across the bank, then across the roll.
  await host.getByRole('button', { name: '↶ Undo' }).click();
  await expect.poll(async () => (await st(host)).players.find((p) => p.pid === b.pid).score).toBe(0);
  await host.keyboard.press('u');
  await expect.poll(async () => (await st(host)).rollCount).toBe(3);
  s = await st(host);
  expect(s.bank).toBe(77);
  expect(s.roller).toBe(b.pid);
  await expect(b.page.locator('.roll-btn')).toBeVisible();

  // Bust: a 7 on roll 4 wipes out everyone who hasn't banked.
  await rig(host, [6, 1]);
  await b.page.locator('.roll-btn').click();
  await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
  s = await st(host);
  expect(s.roundEnd.reason).toBe('bust');
  expect(s.roundEnd.gains).toEqual({ [a.pid]: 0, [c.pid]: 3, [b.pid]: 0 });
  await expect(host.locator('.round-end .re-title')).toHaveText('Seven!');
  await expect(a.page.locator('.bp-round')).toContainText('You got 0 this round');
  await expect(c.page.locator('.bp-round')).toContainText('You banked +3');

  // Undo across the bust restores the round.
  await host.locator('.round-end').getByRole('button', { name: '↶ Undo' }).click();
  await expect.poll(async () => (await st(host)).phase).toBe('roll');
  expect((await st(host)).rollCount).toBe(3);

  for (const p of [a, b, c]) await noSidewaysScroll(p.page);
  expect(errors).toEqual([]);
});

test('TV rolls, everyone banked, late joiner, kick and rejoin', async ({ context }) => {
  const errors = [];
  const { host, code, players: [a, b] } = await setup(context, ['Ana', 'Ben'], errors);
  await setRounds(host, 10);
  await host.locator('.opt', { hasText: 'Players roll' }).locator('.toggle').click();
  await startBank(host);

  // With phoneRoll off, phones can't roll and the TV rolls with Space.
  await expect(a.page.locator('.roll-btn')).toHaveCount(0);
  expect(await send(a.page, { type: 'roll' })).toEqual({ ok: false, err: 'The TV rolls this game' });
  await rig(host, [2, 3]);
  await host.keyboard.press('Space');
  await waitRolls(host, 1);
  expect((await st(host)).bank).toBe(5);

  // Late joiner mid-round becomes a spectator until the next round.
  const c = await openPlayer(context, code, 'Cy', { errors });
  await expect.poll(async () => (await st(host)).waiting).toEqual([c.pid]);
  await expect(c.page.locator('.bank-phone')).toContainText("You'll take a seat with 0 points");
  await expect(c.page.locator('.bank-btn')).toContainText('You join next round');

  // Everyone banked ends the round.
  await a.page.locator('.bank-btn').click();
  await b.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
  expect((await st(host)).roundEnd.reason).toBe('allBanked');
  await expect(host.locator('.round-end .re-title')).toHaveText('Everyone banked');

  await host.locator('.round-end').getByRole('button', { name: 'Next round' }).click();
  await expect.poll(async () => (await st(host)).players.map((p) => p.pid)).toEqual([a.pid, b.pid, c.pid]);
  let s = await st(host);
  expect(s.round).toBe(2);
  expect(s.players.find((p) => p.pid === c.pid).score).toBe(0);
  expect(s.roller).toBe(b.pid); // the player after the last roller (Ana)
  await expect(c.page.locator('.bank-phone .bp-me')).toContainText('Your score');

  // Kick Cy → their phone says so; they can rejoin.
  await host.getByRole('button', { name: '☰ Menu' }).click();
  await host.getByRole('button', { name: 'End game → lobby' }).click();
  await host.getByRole('button', { name: 'End game', exact: true }).click();
  await expect(host.locator('.lobby')).toBeVisible();
  await host.getByRole('button', { name: 'Kick Cy' }).click();
  await host.getByRole('button', { name: 'Remove' }).click();
  await expect(c.page.getByText('You were removed from the room')).toBeVisible();
  await expect(host.locator('.roster-row')).toHaveCount(2);
  await c.page.getByRole('button', { name: 'Rejoin' }).click();
  await expect(c.page.locator('.youre-in')).toBeVisible();
  await expect(host.locator('.roster-row')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('TV refresh mid-round (even mid-roll) resumes; phone refresh resumes its seat', async ({ context }) => {
  const errors = [];
  const { host, players: [a, b] } = await setup(context, ['Ana', 'Ben'], errors);
  await setRounds(host, 10);
  await startBank(host);
  await rig(host, [4, 5]);
  await a.page.locator('.roll-btn').click();
  await waitRolls(host, 1);
  await b.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).players.find((p) => p.pid === b.pid).score).toBe(9);

  // Refresh the TV.
  await host.reload();
  await expect(host.locator('.bank-tv')).toBeVisible();
  await expect(host.locator('.bank-num')).toHaveText('9');
  let s = await st(host);
  expect(s.rollCount).toBe(1);
  expect(s.players.find((p) => p.pid === b.pid).banked).toBe(true);

  // Phones keep working against the resumed host (Ana is the only one in, so she rolls again).
  await expect(a.page.locator('.roll-btn')).toBeVisible();
  await a.page.locator('.roll-btn').click();
  // Refresh the TV while the dice are in the air: the scheduled resolve survives.
  await expect.poll(async () => (await st(host)).rolling).toBe(true);
  await host.reload();
  await expect(host.locator('.bank-tv')).toBeVisible();
  await waitRolls(host, 2);

  // Refresh a phone: it rejoins the same seat.
  await a.page.reload();
  await expect(a.page.locator('.bank-phone')).toBeVisible();
  expect(await a.page.evaluate(() => window.__gn.pid)).toBe(a.pid);
  await expect(host.locator('.sb-row')).toHaveCount(2);
  await expect(a.page.locator('.bank-btn')).toBeEnabled();
  await a.page.locator('.bank-btn').click();
  await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
  expect(errors).toEqual([]);
});

test('final podium, play again, back to lobby', async ({ context }) => {
  const errors = [];
  const { host, players: [a, b] } = await setup(context, ['Ana', 'Ben'], errors);
  await setRounds(host, 10);
  await startBank(host);

  const playOut = async () => {
    for (let r = 1; r <= 10; r++) {
      await rig(host, [1, r % 6 + 1]);
      await host.evaluate(() => window.__gn.hostAct({ type: 'roll' }));
      await expect.poll(async () => (await st(host)).rollCount).toBe(1);
      await host.evaluate(([pa, pb]) => { window.__gn.actFor(pa, { type: 'bank' }); window.__gn.actFor(pb, { type: 'bank' }); }, [a.pid, b.pid]);
      await expect.poll(async () => (await st(host)).phase).toBe('roundEnd');
      await host.keyboard.press('Space');
      await expect.poll(async () => { const s = await st(host); return s.phase === 'over' || s.round === r + 1; }).toBe(true);
    }
  };
  await playOut();
  await expect(host.locator('.results-overlay .podium')).toBeVisible();
  await expect(host.locator('.results-title')).toContainText('Tie');
  await expect(a.page.locator('.phone-results .podium')).toBeVisible();
  await expect(host.locator('table.results tbody tr')).toHaveCount(2);

  // Play again: same seats and options, fresh scores.
  await host.getByRole('button', { name: 'Play again' }).click();
  await expect(host.locator('.results-overlay')).toHaveCount(0);
  let s = await st(host);
  expect(s.round).toBe(1);
  expect(s.rounds).toBe(10);
  expect(s.players.map((p) => [p.pid, p.score])).toEqual([[a.pid, 0], [b.pid, 0]]);
  await expect(a.page.locator('.bank-phone')).toBeVisible();

  // Finish a second game, then go back to the lobby.
  await playOut();
  await expect(host.getByRole('button', { name: 'Back to lobby' })).toBeVisible();
  await host.getByRole('button', { name: 'Back to lobby' }).click();
  await expect(host.locator('.lobby')).toBeVisible();
  await expect(a.page.locator('.youre-in')).toBeVisible();
  expect((await R(host)).lobby.options.rounds).toBe(10);
  expect(errors).toEqual([]);
});

test('layout fits the TV and phones @layout', async ({ context }) => {
  const errors = [];
  const { host, players } = await setup(context, ['Ana', 'Ben', 'A very long name'], errors);
  await noSidewaysScroll(host);
  await startBank(host);
  await expect(players[0].page.locator('.bank-phone')).toBeVisible();
  await noSidewaysScroll(host);
  const vp = host.viewportSize();
  for (const sel of ['.bank-num', '.topbar', '.bank-board']) {
    const box = await host.locator(sel).first().boundingBox();
    expect(box.x + box.width, sel).toBeLessThanOrEqual(vp.width + 1);
    expect(box.y + box.height, sel).toBeLessThanOrEqual(vp.height + 1);
  }
  for (const w of [360, 430]) {
    await players[2].page.setViewportSize({ width: w, height: 800 });
    await noSidewaysScroll(players[2].page);
  }
  expect(errors).toEqual([]);
});

test('turn timer: a roller who runs out of time gets rolled for', async ({ context }) => {
  const errors = [];
  const { host, players: [a, b] } = await setup(context, ['Ana', 'Ben'], errors);
  await startBank(host);
  await host.evaluate(() => { window.__gn.R.settings.timer = 2; }); // seconds; the Menu offers 30/60/90
  await host.evaluate(() => window.__gn.hostAct({ type: 'skip' })); // new roller → deadline armed
  await expect(host.locator('.topbar .timer')).toContainText('⏱');
  await expect(b.page.locator('#phone-timer')).toContainText('⏱');
  await rig(host, [1, 1]);
  await waitRolls(host, 1);
  expect((await st(host)).bank).toBe(2);
  void a;
  expect(errors).toEqual([]);
});
