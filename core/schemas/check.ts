// Hand-written validation combinators for the file formats of spec section 8.
// A Spec appends readable problems ("path: message") to `out` and never throws.
// No dependencies, no I/O.

import { isRound1 } from './precision.ts';

export type Spec = (value: unknown, path: string, out: string[]) => void;

/** Returns readable problems; an empty list means the value is valid. */
export interface Validator<T> {
  (value: unknown): string[];
  /** Phantom marker that lets parseJson/parseJsonl infer the row type. Never set. */
  readonly __row?: T;
}

export function makeValidator<T>(spec: Spec): Validator<T> {
  return (value: unknown): string[] => {
    const out: string[] = [];
    spec(value, '', out);
    return out;
  };
}

/** Problems at most reported for the items of one array before a summary line. */
export const MAX_ITEM_PROBLEMS = 10;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Short description of a value for error messages. */
export function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.length > 48 ? `${v.slice(0, 45)}...` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return `${v} (bigint)`;
  if (Array.isArray(v)) return `a list of ${v.length}`;
  if (typeof v === 'object') return 'an object';
  return typeof v;
}

export function fail(out: string[], path: string, msg: string): void {
  out.push(path === '' ? msg : `${path}: ${msg}`);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function keyPath(path: string, key: string): string {
  const part = IDENT.test(key) ? key : `[${JSON.stringify(key)}]`;
  if (path === '') return part;
  return part.startsWith('[') ? `${path}${part}` : `${path}.${part}`;
}

export function indexPath(path: string, i: number): string {
  return `${path}[${i}]`;
}

// ---- primitives ------------------------------------------------------------

export interface IntOptions {
  min?: number;
  max?: number;
  what?: string;
}

export const int =
  (o: IntOptions = {}): Spec =>
  (v, p, out) => {
    const what = o.what ?? 'an integer';
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      fail(out, p, `expected ${what}, got ${describe(v)}`);
      return;
    }
    if (o.min !== undefined && v < o.min) fail(out, p, `expected ${what} >= ${o.min}, got ${v}`);
    else if (o.max !== undefined && v > o.max) fail(out, p, `expected ${what} <= ${o.max}, got ${v}`);
  };

export interface NumOptions {
  min?: number;
  max?: number;
  what?: string;
  /** Report value in ms or dB: at most one decimal (spec 8.1). */
  round1?: boolean;
}

export const num =
  (o: NumOptions = {}): Spec =>
  (v, p, out) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(out, p, `expected ${o.what ?? 'a finite number'}, got ${describe(v)}`);
      return;
    }
    if (o.min !== undefined && v < o.min) fail(out, p, `expected a number >= ${o.min}, got ${v}`);
    else if (o.max !== undefined && v > o.max) fail(out, p, `expected a number <= ${o.max}, got ${v}`);
    else if (o.round1 === true && !isRound1(v)) {
      fail(out, p, `expected a report value rounded to 0.1 (spec 8.1), got ${v}`);
    }
  };

export interface StrOptions {
  pattern?: RegExp;
  what?: string;
  /** Default true: the empty string is rejected. */
  nonEmpty?: boolean;
}

export const str =
  (o: StrOptions = {}): Spec =>
  (v, p, out) => {
    const what = o.what ?? (o.nonEmpty === false ? 'a string' : 'a non-empty string');
    if (typeof v !== 'string') {
      fail(out, p, `expected ${what}, got ${describe(v)}`);
      return;
    }
    if (o.nonEmpty !== false && v === '') fail(out, p, `expected ${what}, got ""`);
    else if (o.pattern !== undefined && !o.pattern.test(v)) fail(out, p, `expected ${what}, got ${describe(v)}`);
  };

export const bool: Spec = (v, p, out) => {
  if (typeof v !== 'boolean') fail(out, p, `expected true or false, got ${describe(v)}`);
};

export const lit =
  (value: string | number | boolean | null): Spec =>
  (v, p, out) => {
    if (v !== value) fail(out, p, `expected ${JSON.stringify(value)}, got ${describe(v)}`);
  };

export const oneOf =
  (values: readonly (string | number)[], what?: string): Spec =>
  (v, p, out) => {
    if (!values.includes(v as string | number)) {
      const list = values.map((x) => JSON.stringify(x)).join(', ');
      fail(out, p, `expected ${what ?? `one of ${list}`}, got ${describe(v)}`);
    }
  };

export const nullable =
  (spec: Spec): Spec =>
  (v, p, out) => {
    if (v !== null) spec(v, p, out);
  };

/** Passes when any spec passes; otherwise one message naming `what`. */
export const anyOf =
  (specs: readonly Spec[], what: string): Spec =>
  (v, p, out) => {
    for (const s of specs) {
      const tmp: string[] = [];
      s(v, p, tmp);
      if (tmp.length === 0) return;
    }
    fail(out, p, `expected ${what}, got ${describe(v)}`);
  };

/** A JSON primitive: string, finite number, boolean or null. */
export const primitive: Spec = (v, p, out) => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  fail(out, p, `expected a string, number, boolean or null, got ${describe(v)}`);
};

/** Any JSON value (finite numbers only). */
export const jsonValue: Spec = (v, p, out) => {
  if (Array.isArray(v)) {
    v.forEach((x, i) => jsonValue(x, indexPath(p, i), out));
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) jsonValue(x, keyPath(p, k), out);
    return;
  }
  primitive(v, p, out);
};

// ---- containers ------------------------------------------------------------

export interface ArrayOptions {
  len?: number;
  min?: number;
  max?: number;
  what?: string;
}

export const arrayOf =
  (item: Spec, o: ArrayOptions = {}): Spec =>
  (v, p, out) => {
    if (!Array.isArray(v)) {
      fail(out, p, `expected ${o.what ?? 'a list'}, got ${describe(v)}`);
      return;
    }
    if (o.len !== undefined && v.length !== o.len) fail(out, p, `expected ${o.len} items, got ${v.length}`);
    else if (o.min !== undefined && v.length < o.min) fail(out, p, `expected at least ${o.min} items, got ${v.length}`);
    else if (o.max !== undefined && v.length > o.max) fail(out, p, `expected at most ${o.max} items, got ${v.length}`);
    const tmp: string[] = [];
    let bad = 0;
    v.forEach((x, i) => {
      const before = tmp.length;
      item(x, indexPath(p, i), tmp);
      if (tmp.length > before) bad++;
    });
    out.push(...tmp.slice(0, MAX_ITEM_PROBLEMS));
    if (tmp.length > MAX_ITEM_PROBLEMS) {
      fail(out, p, `... ${tmp.length - MAX_ITEM_PROBLEMS} more problems (${bad} bad items in all)`);
    }
  };

export const tuple =
  (items: readonly Spec[], what?: string): Spec =>
  (v, p, out) => {
    if (!Array.isArray(v) || v.length !== items.length) {
      fail(out, p, `expected ${what ?? `a list of ${items.length}`}, got ${describe(v)}`);
      return;
    }
    items.forEach((s, i) => s(v[i], indexPath(p, i), out));
  };

export interface MapOptions {
  key?: RegExp;
  keyWhat?: string;
  minKeys?: number;
  what?: string;
}

/** An object used as a map: arbitrary keys (optionally matching a pattern), uniform values. */
export const mapOf =
  (value: Spec, o: MapOptions = {}): Spec =>
  (v, p, out) => {
    if (!isPlainObject(v)) {
      fail(out, p, `expected ${o.what ?? 'an object'}, got ${describe(v)}`);
      return;
    }
    const entries = Object.entries(v);
    if (o.minKeys !== undefined && entries.length < o.minKeys) {
      fail(out, p, `expected at least ${o.minKeys} entries, got ${entries.length}`);
    }
    for (const [k, x] of entries) {
      if (o.key !== undefined && !o.key.test(k)) {
        fail(out, keyPath(p, k), `unexpected key (expected ${o.keyWhat ?? String(o.key)})`);
        continue;
      }
      value(x, keyPath(p, k), out);
    }
  };

export interface ObjectOptions {
  required?: Record<string, Spec>;
  optional?: Record<string, Spec>;
  /** true: unknown fields allowed; a Spec: unknown fields validated by it. Default: rejected. */
  open?: boolean | Spec;
  /** Fields that are never allowed, with the reason shown in the message. */
  forbidden?: Record<string, string>;
  /** Cross-field rules; run only when the fields themselves are valid. */
  check?: (o: Record<string, unknown>, path: string, out: string[]) => void;
  what?: string;
}

export const obj =
  (o: ObjectOptions): Spec =>
  (v, p, out) => {
    if (!isPlainObject(v)) {
      fail(out, p, `expected ${o.what ?? 'an object'}, got ${describe(v)}`);
      return;
    }
    const before = out.length;
    const required = o.required ?? {};
    const optional = o.optional ?? {};
    for (const [k, s] of Object.entries(required)) {
      if (!Object.hasOwn(v, k) || v[k] === undefined) fail(out, keyPath(p, k), 'missing');
      else s(v[k], keyPath(p, k), out);
    }
    for (const [k, s] of Object.entries(optional)) {
      if (Object.hasOwn(v, k) && v[k] !== undefined) s(v[k], keyPath(p, k), out);
    }
    for (const k of Object.keys(v)) {
      if (Object.hasOwn(required, k) || Object.hasOwn(optional, k)) continue;
      const reason = o.forbidden !== undefined && Object.hasOwn(o.forbidden, k) ? o.forbidden[k] : undefined;
      if (reason !== undefined) fail(out, keyPath(p, k), `not allowed: ${reason}`);
      else if (o.open === true) continue;
      else if (typeof o.open === 'function') o.open(v[k], keyPath(p, k), out);
      else fail(out, keyPath(p, k), 'unexpected field');
    }
    if (o.check !== undefined && out.length === before) o.check(v, p, out);
  };

/** Discriminated union: picks the spec by the string in `field`. */
export const byKind =
  (field: string, specs: Record<string, Spec>, what = 'kind'): Spec =>
  (v, p, out) => {
    if (!isPlainObject(v)) {
      fail(out, p, `expected an object, got ${describe(v)}`);
      return;
    }
    const kinds = Object.keys(specs).join(', ');
    const kind = v[field];
    if (kind === undefined) {
      fail(out, keyPath(p, field), `missing (expected one of ${kinds})`);
      return;
    }
    const spec = typeof kind === 'string' && Object.hasOwn(specs, kind) ? specs[kind] : undefined;
    if (spec === undefined) {
      fail(out, keyPath(p, field), `unknown ${what} ${describe(kind)} (expected one of ${kinds})`);
      return;
    }
    spec(v, p, out);
  };

// ---- report precision --------------------------------------------------------

const MS_OR_DB = /(^|_)(ms|db)(_|$)/i;

/** True for keys that name a report value in ms or dB, such as `median_lead_ms` or `floor_db`. */
export function isMsOrDbKey(key: string): boolean {
  return MS_OR_DB.test(key);
}

/**
 * Spec 8.1: report values in ms and dB are rounded to 0.1. Checks every number under a
 * key that names ms or dB (the key itself or any enclosing key).
 */
export const reportPrecision: Spec = (v, p, out) => {
  const walk = (x: unknown, path: string, inMsDb: boolean): void => {
    if (typeof x === 'number') {
      if (inMsDb && Number.isFinite(x) && !isRound1(x)) {
        fail(out, path, `expected a report value rounded to 0.1 (spec 8.1), got ${x}`);
      }
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((y, i) => walk(y, indexPath(path, i), inMsDb));
      return;
    }
    if (isPlainObject(x)) {
      for (const [k, y] of Object.entries(x)) walk(y, keyPath(path, k), inMsDb || isMsOrDbKey(k));
    }
  };
  walk(v, p, false);
};
