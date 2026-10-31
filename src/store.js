// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in bsblan-state.json, readable by the container user only
// (0600):
//   - `pausedUntil`: the end of a pause after an HTTP 429 or 5xx;
//   - `auth`: `{ failures, until }` after credentials refused (401/403): no
//     request before `until`, the next tries spaced (15 min, 1 h, 6 h, 24 h);
//   - `stops`: the protective commands kept until a read shows them applied
//     (Protection on 700/1000, hot water Off on 1600): `{ mac, role,
//     address, sent, after, other, diff }`, one per role and adapter. Never
//     lifted by time.
// A file that cannot be read (other than missing) is NOT empty: `load`
// throws, and the app never overwrites it (src/app.js saveMemory).
// Never a secret: no passkey, no user name, no password, not even a hash of
// them. Read back bounded (a clock moved or a file edited by hand never
// gives a pause longer than its maximum), only known keys of the expected
// shape (never an inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { FEATURES, TIMINGS } from './constants.js';
import { DHW_MODES, MODES } from './params.js';

/** The protective roles and the values a kept stop may name. */
export const STOP_ROLES = [FEATURES.MODE, FEATURES.HC2_MODE, FEATURES.DHW_MODE_SELECT];
const STOP_VALUES = new Set([...Object.values(MODES), ...Object.values(DHW_MODES)]);
const STOP_MAX = 6;

export const STATE_FILE = '/data/bsblan-state.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** null when the file is missing; throws when it exists but cannot be read. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw new Error('unreadable', { cause: err });
      }
      if (text.length > 16384) {
        throw new Error('unreadable');
      }
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file; `failing` refuses
 * every save, `frozen` never settles a save nor a load, `unreadable` makes
 * `load` throw (a file there but not readable).
 */
export function memoryStore(
  initial = null,
  { failing = false, frozen = false, unreadable = false } = {},
) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    attempts: 0,
    failing,
    frozen,
    unreadable,
    load() {
      if (this.frozen) {
        return new Promise(() => {});
      }
      if (this.unreadable) {
        return Promise.reject(new Error('unreadable'));
      }
      return Promise.resolve(this.data === null ? null : JSON.parse(JSON.stringify(this.data)));
    },
    async save(data) {
      this.attempts += 1;
      if (this.frozen) {
        return new Promise(() => {});
      }
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const lastAuthRetry = TIMINGS.authRetry.at(-1);

/** The persisted state, repaired and bounded against `now`. */
export function normalizeMemory(raw, now) {
  const until = (value, max) =>
    Number.isFinite(value) && value > now ? Math.min(value, now + max) : 0;
  const auth = own(raw, 'auth');
  const failures = own(auth, 'failures');
  return {
    pausedUntil: until(own(raw, 'pausedUntil'), TIMINGS.pauseMax),
    auth: {
      failures: Number.isInteger(failures) && failures > 0 ? Math.min(failures, 1000) : 0,
      until: until(own(auth, 'until'), lastAuthRetry),
    },
    stops: normalizeStops(own(raw, 'stops')),
  };
}

/**
 * The kept stops, repaired: a known role and a MAC, one per role and MAC.
 * An unreadable count is 0 (never sent); no age limit.
 */
export function normalizeStops(list) {
  const count = (value, max) => (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0);
  const value = (v) => (typeof v === 'string' && STOP_VALUES.has(v) ? v : undefined);
  const out = [];
  for (const entry of Array.isArray(list) ? list.slice(0, 20) : []) {
    const mac = own(entry, 'mac');
    const role = own(entry, 'role');
    const address = own(entry, 'address');
    if (
      typeof mac !== 'string' ||
      !/^[0-9a-f]{12}$/.test(mac) ||
      !STOP_ROLES.includes(role) ||
      out.some((s) => s.mac === mac && s.role === role)
    ) {
      continue;
    }
    const other = value(own(entry, 'other'));
    out.push({
      mac,
      role,
      // host or host:port, never a path nor credentials (not a secret).
      address:
        typeof address === 'string' && /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(address)
          ? address
          : undefined,
      sent: count(own(entry, 'sent'), 1000),
      after: value(own(entry, 'after')),
      other,
      diff: other === undefined ? 0 : count(own(entry, 'diff'), 1),
      // Runtime only: older than any command and any request of this run;
      // `restart`: to send once this run (first, or right after its MAC is read).
      restart: true,
      arrival: 0,
      clickSeq: 0,
      writeSeq: 0,
      seenSeq: 0,
    });
  }
  return out.slice(0, STOP_MAX);
}

export const serializeMemory = ({ pausedUntil, auth, stops = [] }) => ({
  pausedUntil,
  auth: { failures: auth.failures, until: auth.until },
  stops: stops.map(({ mac, role, address, sent, after, other, diff }) => ({
    mac,
    role,
    ...(address === undefined ? {} : { address }),
    sent,
    ...(after === undefined ? {} : { after }),
    ...(other === undefined ? {} : { other }),
    diff,
  })),
});
