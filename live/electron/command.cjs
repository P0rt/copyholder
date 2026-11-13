'use strict';
// Pure parts of the Electron fallback launcher (spec 6.7). main.cjs loads Electron; this file does not, so the
// cloud tests can load it.
const path = require('node:path');

const NODE = /^node\s+(\S+)((?:\s+\S+)*)$/; // "node <file> [args]", the form of host's npm scripts
const STEP = /^npm\s+run\s+(?:-s\s+)?([\w:.-]+)$/; // a step before it, e.g. "npm run -s build:web"

/**
 * `npm run live:electron -- <command> [args]`: the root npm script of <command> must be `node <file> [args]`,
 * after optional `npm run -s <script> &&` steps (the page build). argv: the launcher's arguments (an optional
 * leading `--` is skipped). Returns {before: [script names], file, args}; throws otherwise.
 */
function resolveCommand(argv, scripts, root) {
  const rest = argv[0] === '--' ? argv.slice(1) : argv;
  const [cmd, ...extra] = rest;
  if (!cmd) throw new Error('name a command: npm run live:electron -- <command>, e.g. smoke or gate --pack A');
  const own = (name) => name !== 'live:electron' && Object.hasOwn(scripts ?? {}, name);
  const parts = (own(cmd) ? String(scripts[cmd]) : '').split('&&').map((x) => x.trim());
  const m = NODE.exec(parts.pop());
  const before = parts.map((x) => STEP.exec(x)?.[1]);
  if (!m || !before.every((name) => name && own(name) && name !== cmd)) {
    throw new Error(`"${cmd}" is not an npm script of the form "[npm run -s <script> && ]node <file> [args]"`);
  }
  return { before, file: path.resolve(root, m[1]), args: [...m[2].split(/\s+/).filter(Boolean), ...extra] };
}

/** Only host's page may open in the window: http://127.0.0.1:<port>/... (spec 7.2). */
function isHostPage(url) {
  try {
    const u = new URL(url);
    const plain = u.username === '' && u.password === '';
    return plain && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '';
  } catch {
    return false;
  }
}

module.exports = { resolveCommand, isHostPage };
