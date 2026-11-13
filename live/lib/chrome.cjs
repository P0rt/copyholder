'use strict';
// Opening the page (spec 7.2, 7.3): a separate full-screen Chrome window with its own profile,
// started through /usr/bin/open by absolute path (no shell, so no alias of `open` applies).
// Under the Electron fallback (spec 6.7) the launcher opens the window: host sends it {t:'open', url}.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const OPEN_BIN = '/usr/bin/open';

/** Chrome flags: app window, full screen, own profile, autoplay, no throttling of a hidden or covered window. */
function chromeFlags(url, profileDir) {
  return [
    `--app=${url}`,
    '--new-window',
    '--start-fullscreen',
    `--user-data-dir=${profileDir}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** argv for /usr/bin/open. */
function openArgs(url, profileDir) {
  return ['-na', 'Google Chrome', '--args', ...chromeFlags(url, profileDir)];
}

/**
 * Opens Chrome on macOS; returns false elsewhere (the caller prints the address).
 * `spawnFn` is injectable for tests.
 */
function openChrome(url, profileDir, { platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'darwin') return false;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    // Chrome creates the profile itself if it can
  }
  const child = spawnFn(OPEN_BIN, openArgs(url, profileDir), { stdio: 'ignore', detached: true });
  if (child && typeof child.unref === 'function') child.unref();
  if (child && typeof child.on === 'function') child.on('error', () => {});
  return true;
}

/**
 * Where the page opens: 'electron' (the fallback launcher got {t:'open', url} over fork IPC),
 * 'chrome' (macOS), or null (print the address). `send` is process.send when host has a parent.
 */
function openPage(url, { launcher, profileDir, send = null, platform = process.platform, spawnFn = spawn }) {
  if (launcher === 'electron' && typeof send === 'function') {
    try {
      send({ t: 'open', url });
      return 'electron';
    } catch {
      return null;
    }
  }
  return openChrome(url, profileDir, { platform, spawnFn }) ? 'chrome' : null;
}

module.exports = { OPEN_BIN, chromeFlags, openArgs, openChrome, openPage };
