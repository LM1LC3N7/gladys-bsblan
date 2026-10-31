// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The passkey and
// the password are kept here only: never logged, never in /data, never in a
// status or an error.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, DHW_CAP, EXTRA_LIMIT, POLL_INTERVAL } from './constants.js';
import { HC2_REST, POLL } from './params.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_commands: false,
  dhw_max_temperature: DHW_CAP.default,
  poll_interval: POLL_INTERVAL.default,
  extra_parameters: '',
  language: 'fr',
};

/** The parameters the integration reads anyway: never a second feature. */
const BUILT_IN = new Set([...POLL.bsb, ...HC2_REST, ...POLL.pps, '6224']);

/**
 * The read-only parameters typed in the configuration: numbers of 1 to 5
 * digits, separated by commas, semicolons or spaces, at most EXTRA_LIMIT,
 * without duplicates nor those the integration reads anyway. Anything else
 * is ignored and listed (bounded, for the status). Never written.
 * @returns {{ ids: string[], ignored: string[] }}
 */
export function extraParamsOf(raw) {
  const ids = [];
  const ignored = [];
  const text = typeof raw === 'string' ? raw.slice(0, 400) : '';
  for (const token of text.split(/[\s,;]+/)) {
    if (token === '') {
      continue;
    }
    // 1 to 99999 (BSB-LAN has no parameter 0; `param-0` is not a feature id).
    const id = /^\d{1,5}$/.test(token) && Number(token) > 0 ? String(Number(token)) : undefined;
    if (id === undefined || BUILT_IN.has(id) || ids.includes(id) || ids.length >= EXTRA_LIMIT) {
      if (ignored.length < 5) {
        ignored.push(token.slice(0, 12));
      }
      continue;
    }
    ids.push(id);
  }
  return { ids, ignored };
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** The BSB-LAN passkey: a short word of the adapter's configuration, sent in the path. */
const PASSKEY = /^[A-Za-z0-9_-]{1,64}$/;
/** What an HTTP basic authentication header carries: printable ASCII, no colon in the user. */
const USER = /^[\x21-\x39\x3b-\x7e]{1,64}$/;
const PASSWORD = /^[\x20-\x7e]{1,128}$/;

/**
 * The address of the adapter typed by the user: an IPv4 address or a host
 * name, with an optional port (80 by default), with or without `http://`.
 * https, credentials, a path (a pasted passkey), a query are refused: said
 * to the user rather than failing in silence.
 * @returns {{ host: string, port: number } | { error: string }}
 */
export function parseAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { error: 'empty' };
  }
  if (text.length > 260) {
    return { error: 'invalid' };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme === 'https') {
    return { error: 'https' };
  }
  if (scheme && scheme !== 'http') {
    return { error: 'invalid' };
  }
  const rest = scheme ? text.slice(scheme.length + 3) : text;
  const match = /^([^/?#@]*)(@)?([^/?#]*)([/?#].*)?$/.exec(rest);
  if (!match) {
    return { error: 'invalid' };
  }
  if (match[2]) {
    return { error: 'credentials' };
  }
  const path = match[4] ?? '';
  if (path !== '' && path !== '/') {
    return { error: 'path' };
  }
  const authority = match[1].toLowerCase();
  const hostPort = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hostPort) {
    return { error: 'invalid' };
  }
  const host = hostPort[1];
  const port = hostPort[2] === undefined ? DEFAULT_PORT : Number(hostPort[2]);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { error: 'invalid' };
  }
  if (IPV4.test(host)) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host) || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return { host, port };
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The hot water ceiling: whole degrees within DHW_CAP, else the default
 * (65 °C). Never above DHW_CAP.max, whatever was typed.
 */
export function dhwCapOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return DHW_CAP.default;
  }
  return Math.min(DHW_CAP.max, Math.max(DHW_CAP.min, Math.floor(number)));
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * An invalid address as the status may show it: without what could be a
 * secret (credentials before an `@`, a passkey in the path, a query).
 */
function shown(typed) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(typed)?.[0] ?? '';
  let rest = typed.slice(scheme.length);
  const cut = rest.search(/[/?#]/);
  const tail = cut === -1 ? '' : '/…';
  if (cut !== -1) {
    rest = rest.slice(0, cut);
  }
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    rest = `…@${rest.slice(at + 1)}`;
  }
  return `${scheme}${rest}${tail}`.slice(0, 100);
}

/** The optional fields, without a default in the manifest (two of them are secrets). */
const OPTIONAL = { passkey: '', username: '', password: '' };

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = text(c.address);
  const parsed = parseAddress(typed);
  const address = parsed.error ? undefined : parsed;
  // A passkey pasted with its slashes ("/1234/") is the same passkey.
  const passkey = text(c.passkey).replace(/^\/+|\/+$/g, '');
  const username = text(c.username);
  const password = typeof c.password === 'string' ? c.password : '';
  let problem;
  if (parsed.error) {
    problem = parsed.error;
  } else if (passkey !== '' && !PASSKEY.test(passkey)) {
    problem = 'passkey';
  } else if (username === '' && password !== '') {
    problem = 'passwordWithoutUser';
  } else if (username !== '' && password === '') {
    problem = 'userWithoutPassword';
  } else if (
    (username !== '' && !USER.test(username)) ||
    (password !== '' && !PASSWORD.test(password))
  ) {
    problem = 'credentialsInvalid';
  }
  const interval = numberOf(c.poll_interval);
  const extras = extraParamsOf(c.extra_parameters);
  return {
    address: problem ? undefined : address,
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem,
    /** What was typed as address, when it is not valid (never the passkey nor a password). */
    invalid: parsed.error && typed !== '' ? shown(typed) : undefined,
    passkey,
    username,
    password,
    allowCommands: strictTrue(c.allow_commands),
    dhwCap: dhwCapOf(c.dhw_max_temperature),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
    /** Read-only parameters typed by the user (src/params.js extraOf). */
    extraParams: extras.ids,
    extraIgnored: extras.ignored,
  };
}

/** What a restart depends on: the adapter and how to reach it (compared in memory only). */
export const connectionKey = (config) =>
  JSON.stringify([
    config.address ?? null,
    config.problem ?? null,
    config.passkey,
    config.username,
    config.password,
  ]);
