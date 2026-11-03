import { defineConfig, devices } from '@playwright/test';
import { E2E_GH_ROOT, E2E_HOME, E2E_OMP_SESSIONS, E2E_PORT, E2E_STATE_DIR } from './e2e/daemon.js';

const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The real daemon, driving the scripted fake omp and fake gh instead of a real agent and GitHub.
    command: `bun daemon/main.js --port ${E2E_PORT} --omp tests/fixtures/fake-omp.js --gh tests/fixtures/fake-gh.js`,
    env: { HOME: E2E_HOME, COCKPIT_STATE_DIR: E2E_STATE_DIR, COCKPIT_OMP_SESSIONS: E2E_OMP_SESSIONS, COCKPIT_BUGBOT_POLL_MS: '300', FAKE_GH_ROOT: E2E_GH_ROOT },
    url: BASE_URL,
  },
});
