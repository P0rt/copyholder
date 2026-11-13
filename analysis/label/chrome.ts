// Opening the label page (spec 7.6). On macOS: Google Chrome as an app window through /usr/bin/open
// (an absolute path and no shell, so no alias or PATH entry can stand in for it), with its own
// profile so the label cookie never meets the live page's. Elsewhere the address is printed.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const OPEN_BIN = '/usr/bin/open';

/** Chrome profile of the label page, apart from the live page's ~/.copyholder/chrome-profile. */
export function labelProfileDir(home: string = os.homedir()): string {
  return path.join(home, '.copyholder', 'chrome-label-profile');
}

/** Arguments of `open` for the page: a new Chrome instance with the page as an app window. */
export function chromeOpenArgs(url: string, profileDir: string = labelProfileDir()): string[] {
  return ['-na', 'Google Chrome', '--args', `--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
}

export type PageOpener = (url: string) => { opened: boolean; how: string };

/** Opens the page in Chrome on macOS; on other systems says where to open it. */
export function openLabelPage(url: string, platform: NodeJS.Platform = process.platform): { opened: boolean; how: string } {
  if (platform !== 'darwin') return { opened: false, how: `Open this address in Chrome: ${url}` };
  const child = spawn(OPEN_BIN, chromeOpenArgs(url), { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
  return { opened: true, how: 'The label page opened in Chrome. If it did not, open the address below in Chrome.' };
}
