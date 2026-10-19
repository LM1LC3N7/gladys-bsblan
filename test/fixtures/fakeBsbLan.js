// -----------------------------------------------------------------------------
// A fake BSB-LAN adapter behind the injected HTTP transport: it answers /JI,
// /JV, /JQ and /JS from its parameters as the firmware does (python-bsblan
// fixtures), checks the passkey and the basic authentication, and lets a
// test change its behaviour per request. No network; the latency runs on the
// (mocked) timers.
// -----------------------------------------------------------------------------

import { BsbError, CODES } from '../../src/bsblan/errors.js';

export const HOST = '192.168.1.50';
export const MAC = '00:80:41:19:69:90';
export const MAC_ID = '008041196990';
export const NOW = Date.UTC(2026, 9, 19, 18, 0, 0);

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const temp = (name, value, unit = '°C') => ({
  name,
  dataType_name: 'TEMP',
  dataType_family: 'VALS',
  error: 0,
  value,
  desc: '',
  precision: 0.1,
  dataType: 0,
  readonly: 0,
  unit,
});
const choice = (name, value, desc) => ({
  name,
  dataType_name: 'ENUM',
  dataType_family: 'ENUM',
  error: 0,
  value,
  desc,
  dataType: 1,
  readonly: 0,
  unit: '',
});

/** A BSB controller (RVS21), comfort mode, hot water on. */
export function bsbParams() {
  return {
    700: choice('Operating mode', '3', 'Comfort'),
    710: temp('Comfort setpoint', '20.0'),
    712: temp('Reduced setpoint', '17.0'),
    714: temp('Frost protection setpoint', '10.0'),
    716: temp('Comfort setpoint max', '28.0'),
    8000: choice('Status heating circuit 1', '114', 'Heating mode comfort'),
    8740: temp('Room temperature actual value 1', '19.3', '&deg;C'),
    8700: temp('Outside temp sensor local', '7.6', '&deg;C'),
    1600: choice('Operating mode', '1', 'On'),
    1610: temp('DHW temperature nominal setpoint', '50.0'),
    1612: temp('DHW temperature reduced setpoint', '40.0'),
    1614: temp('DHW temperature nominal setpoint max', '65.0'),
    8830: temp('DHW temperature actual value top (B3)', '48.5'),
    8820: choice('State DHW pump', '255', 'On'),
    3113: {
      name: 'Energy brought in',
      dataType_name: 'STRING',
      dataType_family: 'STRN',
      error: 0,
      value: '7968 kWh',
      desc: '',
      dataType: 7,
      unit: '',
    },
    6224: {
      name: 'Device identification',
      error: 0,
      value: 'RVS21.831F/127',
      desc: '',
      dataType: 7,
      unit: '',
    },
  };
}

export function ppsParams() {
  return {
    15000: choice('Operating mode', '0', 'Automatic'),
    15004: temp('Room setpoint', '20.5'),
    15006: temp('Min', '8.0'),
    15007: temp('Max', '30.0'),
    15008: temp('Room temperature', '19.8'),
    15030: temp('Outside temperature', '5.0'),
  };
}

export const inactive = (name = 'Inactive') => ({
  name,
  error: 0,
  value: '---',
  desc: '',
  dataType: 0,
  unit: '',
});

export function bsbInfo() {
  return {
    name: 'BSB-LAN',
    version: '5.1.0',
    freeram: 85479,
    uptime: 969402857,
    MAC,
    freespace: 0,
    bus: 'BSB',
    buswritable: 1,
    busaddr: 66,
    busdest: 0,
  };
}

const json = (status, value, headers = {}) => ({
  status,
  headers,
  body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
});

/**
 * @param {object} [options]
 * @param {object} [options.params] parameter id -> entry
 * @param {object} [options.info] the /JI answer
 * @param {string | null} [options.apiVersion] null: no /JV (404)
 * @param {string} [options.passkey]
 * @param {{ username: string, password: string }} [options.auth]
 * @param {Function} [options.behave] (request) -> undefined | an override
 * @param {number} [options.latency] ms per request
 */
export function fakeBsbLan({
  params = bsbParams(),
  info = bsbInfo(),
  apiVersion = '2.0',
  passkey = '',
  auth,
  behave,
  latency = 50,
} = {}) {
  const fake = {
    params,
    info,
    apiVersion,
    passkey,
    auth,
    behave,
    latency,
    down: false,
    /** Every request: { endpoint, ids, body, headers, path, options }. */
    requests: [],
    /** [[id, value]] of the /JS requests that were applied. */
    writes: () =>
      fake.requests
        .filter((r) => r.endpoint === '/JS' && r.applied)
        .map((r) => [r.body.Parameter, r.body.Value]),
    reads: () => fake.requests.filter((r) => r.endpoint === '/JQ'),
  };

  const answer = (request) => {
    const prefix = fake.passkey ? `/${fake.passkey}` : '';
    if (!request.path.startsWith(`${prefix}/`)) {
      return json(404, 'Not found');
    }
    if (fake.auth) {
      const expected = `Basic ${Buffer.from(`${fake.auth.username}:${fake.auth.password}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        return json(401, 'Unauthorized');
      }
    }
    switch (request.endpoint) {
      case '/JI':
        return json(200, fake.info);
      case '/JV':
        return fake.apiVersion === null
          ? json(404, '')
          : json(200, { api_version: fake.apiVersion });
      case '/JQ': {
        const out = {};
        for (const id of request.ids) {
          out[id] = Object.hasOwn(fake.params, id) ? fake.params[id] : inactive(`Unknown ${id}`);
        }
        return json(200, out);
      }
      case '/JS': {
        const { Parameter: id, Value: value } = request.body;
        if (!Object.hasOwn(fake.params, id)) {
          return json(200, { [id]: { status: 2 } });
        }
        fake.params[id] = { ...fake.params[id], value };
        request.applied = true;
        return json(200, { [id]: { status: 1 } });
      }
      default:
        return json(404, '');
    }
  };

  fake.request = (options) => {
    const prefix = fake.passkey ? `/${fake.passkey}` : '';
    const rest = options.path.startsWith(prefix) ? options.path.slice(prefix.length) : options.path;
    const endpoint = rest.replace(/\?.*$/, '');
    const ids = /Parameter=([\d,]+)/.exec(rest)?.[1]?.split(',') ?? [];
    const request = {
      endpoint,
      ids,
      path: options.path,
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : undefined,
      options,
    };
    fake.requests.push(request);
    return new Promise((resolve, reject) => {
      if (fake.down) {
        setTimeout(() => reject(new BsbError(CODES.UNREACHABLE)), 10);
        return;
      }
      const override = fake.behave?.(request);
      const delay = override?.delay ?? fake.latency;
      if (override === 'timeout' || delay >= options.timeout) {
        setTimeout(() => reject(new BsbError(CODES.TIMEOUT, { sent: true })), options.timeout);
        return;
      }
      if (override === 'silent-applied') {
        setTimeout(() => {
          answer(request);
          reject(new BsbError(CODES.TIMEOUT, { sent: true }));
        }, options.timeout);
        return;
      }
      setTimeout(() => {
        if (override?.error) {
          reject(new BsbError(override.error, { sent: override.sent ?? false }));
        } else if (override?.status) {
          if (override.apply) {
            answer(request);
          }
          resolve(json(override.status, override.body ?? '', override.headers));
        } else if (override?.raw !== undefined) {
          resolve(json(200, override.raw));
        } else {
          resolve(answer(request));
        }
      }, delay);
    });
  };
  return fake;
}
