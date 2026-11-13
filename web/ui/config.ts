// /api/config (docs/protocol.md, "HTTP (host)") and the URLs the page fetches from host.

export interface PageConfig {
  mode: string;
  sessionId: string;
  scenario: string;
  tapUrl: string | null;
  sessionUrl: string | null;
  /** calib.json of the latest doctor run, or null (spec 8.1). */
  calib: Calib | null;
  /** Narrator names host serves for this scenario. */
  narrator: string[];
  consentText: 'live' | 'mic';
  /** Optional: parts of the device names to pick; absent means the system defaults (spec 5.2). */
  devices: { input?: string; output?: string };
  /** Optional: demo take with the face preview (spec 12.2, 15.5). */
  facePreview: boolean;
  /** The JSON as host served it; the worker gets this, with fields the page does not read. */
  raw: Record<string, unknown>;
}

export interface Calib {
  output_gain?: number;
  [key: string]: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Validates and normalises the /api/config JSON. Throws on a shape the page cannot use. */
export function parseConfig(raw: unknown): PageConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('/api/config did not return a JSON object');
  const r = raw as Record<string, unknown>;
  const narrator = Array.isArray(r.narrator) ? r.narrator.filter((n): n is string => typeof n === 'string') : [];
  const devicesRaw = (typeof r.devices === 'object' && r.devices !== null ? r.devices : {}) as Record<string, unknown>;
  const devices: PageConfig['devices'] = {};
  if (typeof devicesRaw.input === 'string' && devicesRaw.input) devices.input = devicesRaw.input;
  if (typeof devicesRaw.output === 'string' && devicesRaw.output) devices.output = devicesRaw.output;
  const mode = str(r.mode);
  const consentText = r.consentText === 'mic' || r.consentText === 'live' ? r.consentText : mode === 'doctor' || mode === 'spacebar' ? 'mic' : 'live';
  const calib = typeof r.calib === 'object' && r.calib !== null ? (r.calib as Calib) : null;
  return {
    mode,
    sessionId: str(r.sessionId, 'session'),
    scenario: str(r.scenario),
    tapUrl: typeof r.tapUrl === 'string' ? r.tapUrl : null,
    sessionUrl: typeof r.sessionUrl === 'string' ? r.sessionUrl : null,
    calib,
    narrator,
    consentText,
    devices,
    facePreview: r.facePreview === true,
    raw: r,
  };
}

/** API path with the run token from the page address, when there is one (host also accepts its cookie). */
export function apiUrl(path: string, pageSearch: string): string {
  const token = new URLSearchParams(pageSearch).get('token');
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function narratorPath(name: string): string {
  return `/api/narrator/${encodeURIComponent(name)}`;
}
