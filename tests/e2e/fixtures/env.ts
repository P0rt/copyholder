// Playwright helpers: Vite dev server for the harness, Chromium with a fake microphone from a WAV file.

import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { wavBytes } from '../../../web/lib/testing/synth.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const HARNESS_PATH = '/tests/e2e/fixtures/harness.html';

/** Serves the repository with Vite (dev mode transpiles the TypeScript worklet and worker on request). */
export async function startVite(): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const addr = server.httpServer?.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

/** Chromium with the microphone replaced by a WAV file (looped by Chromium). */
export async function launchWithMic(wavPath: string): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

export function writeWav(path: string, samples: Float32Array): string {
  writeFileSync(path, wavBytes(samples));
  return path;
}
