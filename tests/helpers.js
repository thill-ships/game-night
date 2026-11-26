// Shared Playwright helpers. All pages share one browser context, so they share
// localStorage + BroadcastChannel (local mode), but each tab has its own sessionStorage.
const { expect } = require('@playwright/test');

function watchErrors(page, bag) {
  page.on('pageerror', (e) => bag.push(`${page.url()} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/fonts\.(googleapis|gstatic)/.test(m.location().url || '') || /fonts\.(googleapis|gstatic)/.test(m.text())) return; // blocked on purpose
    bag.push(`${page.url()} console: ${m.text()}`);
  });
}

async function openHost(context, { errors = [], fresh = true, query = '' } = {}) {
  const page = await context.newPage();
  watchErrors(page, errors);
  // Block Google Fonts so tests don't depend on the network.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (fresh) {
    await page.goto('/index.html');
    await page.evaluate(() => localStorage.clear());
  }
  await page.goto('/?host&dev' + query);
  await expect(page.locator('.lobby, .tv-game').first()).toBeVisible();
  const code = await page.evaluate(() => window.__gn.R.code);
  return { page, code };
}

async function openPlayer(context, code, name, { errors = [] } = {}) {
  const page = await context.newPage();
  watchErrors(page, errors);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?g=${code}&dev`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.locator('.youre-in, .phone-stage').first()).toBeVisible();
  const pid = await page.evaluate(() => window.__gn.pid);
  return { page, pid, name };
}

// Host-side helpers that read authoritative state.
const R = (host) => host.evaluate(() => window.__gn.R);
const gameState = (host) => host.evaluate(() => window.__gn.R.game && window.__gn.R.game.state);

async function noSidewaysScroll(page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'horizontal overflow on ' + page.url()).toBeLessThanOrEqual(0);
}

module.exports = { openHost, openPlayer, R, gameState, watchErrors, noSidewaysScroll };
