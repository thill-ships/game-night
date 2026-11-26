const { test, expect } = require('@playwright/test');
const { openHost, openPlayer, watchErrors } = require('./helpers');

test('landing, host lobby and a phone join without errors', async ({ context }) => {
  const errors = [];
  const land = await context.newPage();
  watchErrors(land, errors);
  await land.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await land.goto('/');
  await expect(land.getByRole('heading', { name: 'Join a room' })).toBeVisible();
  const { page: host, code } = await openHost(context, { errors });
  await expect(host.locator('.qr-code')).toHaveText(code);
  const a = await openPlayer(context, code, 'Ana', { errors });
  await expect(host.locator('.roster-row')).toHaveCount(1);
  await expect(a.page.locator('.youre-in')).toContainText('Ana');
  expect(errors).toEqual([]);
});
