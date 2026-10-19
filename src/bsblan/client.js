// -----------------------------------------------------------------------------
// The BSB-LAN JSON API, as python-bsblan 6.1.10 uses it (`_transport.py`,
// `bsblan.py`): POST /JI (adapter info), /JV (JSON-API version), /JQ with a
// `Parameter` query of comma-separated ids (read), /JS with a JSON body
// `{ Parameter, Value, Type: "1" }` (write). The passkey, when set, is the
// first part of the path; HTTP basic authentication only when both a user
// name and a password are set.
//
// The adapter is a small board that queries the bus one parameter after the
// other and serves one client at a time: every request goes through the
// Gate, one at a time. A command takes the Gate before the queued poll
// requests (`priority`) and holds it from its fresh read to the end of its
// write (`session`); a request that cannot start before its `startBy` is
// refused LATE, unsent.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from '../constants.js';
import { BsbError, CODES } from './errors.js';
import { httpRequest } from './http.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const LATIN1 = new TextDecoder('latin1');

/** Retry-After: seconds or an HTTP date, in ms (undefined when absent or unreadable). */
export function retryAfterMs(value, now) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || text.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,7}\s*$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * The body of an answer, as JSON. Some firmwares send Latin-1 descriptions
 * without saying so (python-bsblan `_read_json`): UTF-8 first, else Latin-1.
 * Only a JSON object is accepted.
 */
export function decodeBody(buffer) {
  let text;
  try {
    text = UTF8.decode(buffer);
  } catch {
    text = LATIN1.decode(buffer);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BsbError(CODES.BAD_ANSWER, { sent: true });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BsbError(CODES.BAD_ANSWER, { sent: true });
  }
  return value;
}

/** One request at a time; `priority` entries pass before the others. */
export class Gate {
  constructor({ now = Date.now, timers = globalThis } = {}) {
    this.now = now;
    this.timers = timers;
    this.queue = [];
    this.busy = false;
    this.closed = false;
  }

  run(task, { priority = false, startBy } = {}) {
    if (this.closed) {
      return Promise.reject(new BsbError(CODES.CLOSED));
    }
    return new Promise((resolve, reject) => {
      const entry = { task, priority, resolve, reject, timer: undefined };
      if (startBy !== undefined) {
        entry.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(entry);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new BsbError(CODES.LATE));
            }
          },
          Math.max(0, startBy - this.now()),
        );
      }
      if (priority) {
        const at = this.queue.findIndex((e) => !e.priority);
        this.queue.splice(at === -1 ? this.queue.length : at, 0, entry);
      } else {
        this.queue.push(entry);
      }
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.queue.length === 0) {
      return;
    }
    const entry = this.queue.shift();
    if (entry.timer !== undefined) {
      this.timers.clearTimeout(entry.timer);
    }
    this.busy = true;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.timer !== undefined) {
        this.timers.clearTimeout(entry.timer);
      }
      entry.reject(new BsbError(CODES.CLOSED));
    }
  }
}

export class BsbClient {
  /**
   * @param {object} options
   * @param {{ host: string, port: number }} options.address
   * @param {string} [options.passkey]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake adapter)
   */
  constructor({
    address,
    passkey = '',
    username = '',
    password = '',
    request = httpRequest,
    now = Date.now,
    timers = globalThis,
  }) {
    this.address = address;
    this.request = request;
    this.now = now;
    // Kept in this closure only: never on a property a log could print.
    const prefix = passkey ? `/${passkey}` : '';
    const authorization =
      username && password
        ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
        : undefined;
    this.pathOf = (endpoint, query) => `${prefix}${endpoint}${query ?? ''}`;
    this.headers = () => (authorization ? { authorization } : {});
    this.gate = new Gate({ now, timers });
    this.closed = false;
    /** The requests of a command session, without the Gate (it is held). */
    this.raw = {
      query: (ids, options) => this.exchange('/JQ', { query: queryOf(ids), ...options }),
      set: (id, value, options) =>
        this.exchange('/JS', {
          body: JSON.stringify({ Parameter: String(id), Value: String(value), Type: '1' }),
          ...options,
        }),
    };
  }

  close() {
    this.closed = true;
    this.gate.close();
  }

  /**
   * One request, outside the Gate. `answerBy`, `startBy`: absolute times;
   * `beforeSend`: the last check, right before the request leaves (an error
   * it throws is passed on with `beforeSend` set, nothing sent).
   */
  async exchange(endpoint, { query, body, answerBy, startBy, beforeSend } = {}) {
    if (this.closed) {
      throw new BsbError(CODES.CLOSED);
    }
    const now = this.now();
    const timeout = answerBy === undefined ? TIMINGS.requestTimeout : answerBy - now;
    if (timeout <= 0 || (startBy !== undefined && startBy <= now)) {
      throw new BsbError(CODES.LATE);
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    let answer;
    try {
      answer = await this.request({
        method: 'POST',
        host: this.address.host,
        port: this.address.port,
        path: this.pathOf(endpoint, query),
        headers: this.headers(),
        body,
        timeout,
        sendWithin: startBy === undefined ? TIMINGS.connectTimeout : startBy - now,
        maxBytes: LIMITS.bodyBytes,
      });
    } catch (err) {
      // Not connected within the connect timeout of a request without
      // deadline: the adapter is unreachable (nothing was sent).
      if (err?.code === CODES.LATE && startBy === undefined) {
        throw new BsbError(CODES.UNREACHABLE);
      }
      throw err;
    }
    if (this.closed) {
      throw new BsbError(CODES.CLOSED, { sent: true });
    }
    if (answer.status < 200 || answer.status > 299) {
      throw new BsbError(CODES.HTTP, {
        status: answer.status,
        retryAfterMs: retryAfterMs(answer.headers?.['retry-after'], this.now()),
        sent: true,
      });
    }
    return decodeBody(answer.body);
  }

  /** The adapter information (/JI): name, version, MAC, bus, buswritable. */
  info() {
    return this.gate.run(() => this.exchange('/JI'));
  }

  /** The JSON-API version (/JV): `{ api_version }`. */
  apiVersion() {
    return this.gate.run(() => this.exchange('/JV'));
  }

  /** Read parameters (/JQ): an object keyed by parameter id. */
  query(ids) {
    return this.gate.run(() => this.exchange('/JQ', { query: queryOf(ids) }));
  }

  /** A command: `fn(raw)` runs holding the Gate, before the queued poll requests. */
  session(fn, { startBy } = {}) {
    return this.gate.run(() => fn(this.raw), { priority: true, startBy });
  }
}

/** `?Parameter=700,710`: ids are digits only (src/params.js), nothing to escape. */
function queryOf(ids) {
  const list = ids.map(String);
  if (list.length === 0 || !list.every((id) => /^\d{1,5}$/.test(id))) {
    throw new Error('bad parameter ids');
  }
  return `?Parameter=${list.join(',')}`;
}
