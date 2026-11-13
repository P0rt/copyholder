'use strict';
// Fallback launcher (spec 6.7, 7.1), used only if plain Node cannot open the camera in smoke:
//   npm run live:electron -- <command> [args]      e.g.  npm run live:electron -- gate --pack A
// The npm script starts Electron 43.8.1 through `env -u ELECTRON_RUN_AS_NODE` (the VS Code terminal sets it).
// This main process forks the command's host script with Electron's binary in Node mode; host forks tap the
// same way, so tap stays a separate child process and the SDK never loads here. Contract with host: env
// COPYHOLDER_LAUNCHER=electron; host sends {t:'open', url} over its fork IPC instead of opening Chrome, and the
// page opens in an Electron window with backgroundThrottling off.
const electron = require('electron');

if (typeof electron === 'string' || !electron.app) {
  console.error('live:electron: start it with npm run live:electron -- <command> (no ELECTRON_RUN_AS_NODE).');
  process.exit(1);
}
const { app, BrowserWindow, session, systemPreferences } = electron;
const { fork, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveCommand, isHostPage } = require('./command.cjs');

const ROOT = path.join(__dirname, '..', '..');
let timing = {}; // host waits TAP_STOP_BUDGET_MS for tap's stop (live/lib/tap-timing.cjs)
try { timing = require('../lib/tap-timing.cjs'); } catch {}
// after Ctrl+C, host and tap stop the SDK themselves and host saves the run; then the child is killed
const STOP_WAIT_MS = (timing.TAP_STOP_BUDGET_MS ?? 25_000) + 10_000;

// As host's Chrome window (live/lib/chrome.cjs): no throttling of a hidden or covered page, audio without a click.
const NO_THROTTLING = [
  'disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows',
];
for (const s of NO_THROTTLING) app.commandLine.appendSwitch(s);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** host's page in a full-screen window; permissions and navigation only for its own origin. */
function openPage(url) {
  if (!isHostPage(url)) throw new Error('refusing to open a page that is not host\'s (http://127.0.0.1:<port>)');
  const { origin } = new URL(url);
  const own = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, _perm, done, details) => {
    done(own(details?.requestingUrl ?? wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, _perm, requestingOrigin) => own(requestingOrigin));
  const win = new BrowserWindow({
    fullscreen: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, to) => { if (!own(e.url ?? to)) e.preventDefault(); });
  win.loadURL(url);
}

app.on('window-all-closed', () => {}); // host ends the run, not the window
app.whenReady().then(async () => {
  let target;
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    target = resolveCommand(process.argv.slice(process.defaultApp ? 2 : 1), scripts, ROOT); // after the app path
  } catch (e) {
    console.error(`live:electron: ${e.message}`);
    return app.exit(1);
  }
  const shown = [path.relative(ROOT, target.file), ...target.args].join(' ');
  console.error(`live:electron: Electron ${process.versions.electron}: ${shown}`);
  for (const name of target.before) { // the steps of the npm script before node, e.g. the page build
    if (spawnSync('npm', ['run', '-s', name], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
      console.error(`live:electron: npm run ${name} failed`);
      return app.exit(1);
    }
  }
  if (process.platform === 'darwin') {
    // Electron asks for the camera that the forked tap is meant to use (spec 6.7, assumption for smoke).
    for (const media of ['camera', 'microphone']) {
      console.error(`live:electron: ${media} access: ${await systemPreferences.askForMediaAccess(media)}`);
    }
  }
  const child = fork(target.file, target.args, {
    cwd: ROOT,
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COPYHOLDER_LAUNCHER: 'electron' },
  });
  child.on('message', (m) => {
    if (m?.t !== 'open' || typeof m.url !== 'string') return;
    try { openPage(m.url); } catch (e) { console.error(`live:electron: ${e.message}`); }
  });
  child.on('error', (e) => console.error(`live:electron: ${e.message}`));
  child.on('exit', (code, signal) => app.exit(code ?? (signal ? 1 : 0)));
  // Ctrl+C reaches host and tap too: they stop the SDK (await sdk.stopAsync()) and exit; this waits for them.
  const later = () => setTimeout(() => child.kill('SIGTERM'), STOP_WAIT_MS).unref();
  process.on('SIGINT', later);
  process.on('SIGTERM', later);
});
