// Playwright runs everything in local mode: every test URL carries &local (BroadcastChannel, no Supabase).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8123', trace: 'off' },
  webServer: { command: 'node tests/serve.js', url: 'http://localhost:8123/index.html', reuseExistingServer: true },
  projects: [
    { name: 'tv-1080', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'tv-768', use: { viewport: { width: 1366, height: 768 } }, grep: /@layout/ },
  ],
});
