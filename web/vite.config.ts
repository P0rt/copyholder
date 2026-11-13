// Vite config for the page (spec 13.2): root web/, output web/dist (served by host, spec 7.2).
// The Deck worklet and the worker are separate bundles: main.ts imports them with `?worker&url`.
// `--mode standins` swaps in web/lib/stand-ins/ for both and serves fixture /api routes in dev and preview.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { fixtureResponse } from './lib/stand-ins/fixtures.ts';

const WEB = dirname(fileURLToPath(import.meta.url));
const SEPARATE_ENTRIES = ['deck.worklet.ts', 'worker.ts'];
const STAND_IN: Record<string, string> = Object.fromEntries(
  SEPARATE_ENTRIES.map((f) => [resolve(WEB, f), resolve(WEB, 'lib/stand-ins', f)]),
);

function splitQuery(id: string): [string, string] {
  const q = id.indexOf('?');
  return q < 0 ? [id, ''] : [id.slice(0, q), id.slice(q)];
}

function fixtureMiddleware(scenario: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const r = fixtureResponse(req.url ?? '', scenario);
    if (!r) return next();
    res.statusCode = r.status;
    res.setHeader('content-type', r.type);
    res.end(r.body);
  };
}

/** Points ./deck.worklet.ts and ./worker.ts at the stand-ins (queries such as ?worker&url are kept). */
function standIns(scenario: string): Plugin {
  return {
    name: 'copyholder-stand-ins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const [path, query] = splitQuery(source);
      const target = STAND_IN[resolve(dirname(splitQuery(importer)[0]), path)];
      return target ? target + query : null;
    },
    configureServer(server) {
      server.middlewares.use(fixtureMiddleware(scenario));
    },
    configurePreviewServer(server) {
      server.middlewares.use(fixtureMiddleware(scenario));
    },
  };
}

/** A clear message when the real Deck or worker is missing from a production build. */
function requireEntries(): Plugin {
  return {
    name: 'copyholder-require-entries',
    buildStart() {
      const missing = SEPARATE_ENTRIES.filter((f) => !existsSync(resolve(WEB, f)));
      if (missing.length > 0) this.error(`web/${missing.join(', web/')} not found. Build with --mode standins to use web/lib/stand-ins/.`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const useStandIns = mode === 'standins' || process.env.COPYHOLDER_STANDINS === '1';
  const scenario = process.env.COPYHOLDER_STANDIN_SCENARIO ?? 'gate-0';
  return {
    root: WEB,
    base: './',
    publicDir: false,
    plugins: useStandIns ? [standIns(scenario)] : [requireEntries()],
    worker: { format: 'es' },
    build: {
      outDir: resolve(WEB, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: true,
    },
    server: { host: '127.0.0.1', strictPort: false },
    preview: { host: '127.0.0.1' },
  };
});
