// -----------------------------------------------------------------------------
// The points of the first review (I1, I2, M1–M9), one test (or more) each,
// with the same wiring as test/app.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { httpRequest } from '../src/bsblan/http.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  MAC_ID,
  NOW,
  bsbInfo,
  bsbParams,
  fakeBsbLan,
  settle,
} from './fixtures/fakeBsbLan.js';

const ALLOWED = { address: HOST, allow_commands: true };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

async function setup(t, { config = ALLOWED, bsb = fakeBsbLan(), create = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new BsbLanApp({
    gladys,
    logger: silent,
    request: (options) => bsb.request(options),
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(SECOND);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, bsb, advance, command };
}

const jsRequests = (bsb) => bsb.requests.filter((r) => r.endpoint === '/JS');

test('I1 (H15a): write access turned off between two polls: the fresh read of the command refuses', async (t) => {
  const s = await setup(t);
  // As the firmware: write access off makes every parameter read only too.
  s.bsb.info = { ...s.bsb.info, buswritable: 0 };
  s.bsb.params[700] = { ...s.bsb.params[700], readwrite: 1 };
  const ack = await s.command('mode', 'reduced');
  assert.match(ack.error, /lecture seule.*non envoyée/);
  assert.deepEqual(jsRequests(s.bsb), []);
  assert.equal(s.bsb.requests.at(-1).endpoint, '/JQ', 'nothing after the fresh read');
});

test('I1 (H15b): another adapter at the address between two polls: never written to it', async (t) => {
  const s = await setup(t);
  s.bsb.info = { ...s.bsb.info, MAC: '00:80:41:aa:bb:cc' };
  s.bsb.params[1610] = { ...s.bsb.params[1610], value: '45.0' };
  const ack = await s.command('dhw-setpoint', 52);
  assert.match(ack.error, /pas l'adaptateur lu actuellement.*non envoyée/);
  assert.deepEqual(jsRequests(s.bsb), []);
});

test('I1: the /JI and the fresh read share the read budget', async (t) => {
  let slow = false;
  const bsb = fakeBsbLan({
    // 1.5 s for the /JI, 1.5 s for the read: 3 s, above the 2.5 s budget.
    behave: (request) =>
      slow && (request.endpoint === '/JI' || request.ids.length === 1)
        ? { delay: 1_500 }
        : undefined,
  });
  const s = await setup(t, { bsb });
  slow = true;
  const ack = await s.command('mode', 'reduced', { wait: 4_900 });
  assert.ok(ack, 'answered within 5 s');
  assert.match(ack.error, /trop lentement|relue juste avant/);
  assert.deepEqual(jsRequests(bsb), []);
});

test('I2 (H19): a ceiling lowered while the connection of the write opens stops it', async (t) => {
  const bsb = fakeBsbLan();
  const direct = bsb.request;
  let app;
  let lowered = false;
  // A transport whose connection takes 400 ms: the change happens after the
  // first check, before the bytes leave; the check at "connect" sees it.
  bsb.request = (options) => {
    if (options.body && !lowered) {
      lowered = true;
      app.configUpdated({ ...ALLOWED, dhw_max_temperature: 45 });
      return new Promise((resolve) => setTimeout(resolve, 400)).then(() => direct(options));
    }
    return direct(options);
  };
  const s = await setup(t, { bsb });
  app = s.app;
  const ack = await s.command('dhw-setpoint', 52);
  assert.match(ack.error, /plafonnée à 45 °C/);
  assert.deepEqual(bsb.writes(), []);
  assert.deepEqual(jsRequests(bsb), [], 'nothing reached the adapter');
});

test('I2: the real transport calls beforeSend once connected; a refusal sends no byte', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.end('{}');
  });
  let bytes = 0;
  server.on('connection', (socket) => socket.on('data', (chunk) => (bytes += chunk.length)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  let calls = 0;
  await assert.rejects(
    httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/JS',
      body: '{"Parameter":"1610","Value":"52","Type":"1"}',
      timeout: 2000,
      maxBytes: 1000,
      beforeSend: () => {
        calls += 1;
        throw new Error('ceiling lowered');
      },
    }),
    (err) => err.beforeSend === true && err.sent === false && /ceiling/.test(err.message),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);
  assert.equal(bytes, 0);
  assert.deepEqual(seen, []);
  // Allowed: the request leaves.
  const ok = await httpRequest({
    method: 'POST',
    host: '127.0.0.1',
    port,
    path: '/JS',
    body: '{}',
    timeout: 2000,
    maxBytes: 1000,
    beforeSend: () => {},
  });
  assert.equal(ok.status, 200);
});

test('M1: the range shown for hot water includes the ceiling', async (t) => {
  const s = await setup(t);
  await s.app.configUpdated({ ...ALLOWED, dhw_max_temperature: 48 });
  assert.match((await s.command('dhw-setpoint', 38)).error, /entre 40 et 48 °C/);
});

test('M2: no follow-up read while the adapter is known not to answer', async (t) => {
  const bsb = fakeBsbLan({
    behave: (request) => (request.endpoint === '/JS' ? 'timeout' : undefined),
  });
  const s = await setup(t, { bsb });
  await s.command('mode', 'reduced', { wait: 4_400 });
  bsb.down = true;
  await s.advance(6 * SECOND); // the follow-up at 5 s fails: offline, backoff 30 s
  assert.equal(s.app.adapter.online, false);
  const count = bsb.requests.length;
  await s.advance(16 * SECOND); // past the follow-up at 20 s
  assert.equal(bsb.requests.length, count, 'the 20 s follow-up is skipped');
});

test('M3: a poll started before a command never republishes what the command re-read', async (t) => {
  let slow = false;
  const bsb = fakeBsbLan({
    behave: (request) =>
      slow && request.endpoint === '/JQ' && request.ids.length === 4 ? { delay: 900 } : undefined,
  });
  const s = await setup(t, { bsb });
  slow = true;
  await s.advance(30 * SECOND + 300); // a poll starts; its first batch (700 = comfort) in flight
  // Changed by hand on the controller before the command re-reads it.
  bsb.params[700] = { ...bsb.params[700], value: '1' };
  const ack = await s.command('mode', 'reduced', { wait: 1_500 });
  assert.equal(ack.success, true);
  await s.advance(3 * SECOND); // the poll ends, before the follow-up at 5 s
  assert.notEqual(s.gladys.fake.lastState(feature('mode')), 'comfort', 'never the older value');
});

test('M3 (H20): a poll batch read after the write is newer than the command and is shown', async (t) => {
  let slow = false;
  const bsb = fakeBsbLan({
    behave: (request) =>
      slow && request.endpoint === '/JQ' && request.ids.length === 4 ? { delay: 900 } : undefined,
  });
  const s = await setup(t, { bsb });
  slow = true;
  await s.advance(30 * SECOND + 300); // batch 1 (700, 710, 712, 714) in flight
  const ack = await s.command('dhw-setpoint', 52, { wait: 1_500 });
  assert.equal(ack.success, true);
  await s.advance(3 * SECOND); // batch 3 (1600, 1610, …) is read after the write
  const batch3 = bsb.requests.filter((r) => r.ids[0] === '1600').at(-1);
  const write = bsb.requests.findLastIndex((r) => r.endpoint === '/JS');
  assert.ok(bsb.requests.indexOf(batch3) > write, 'the batch came after the write');
  assert.equal(s.gladys.fake.lastState(feature('dhw-setpoint')), 52, 'the newer value');
});

test('hot water: 1612 above the ceiling is named, not "no range"', async (t) => {
  const s = await setup(t);
  await s.app.configUpdated({ ...ALLOWED, dhw_max_temperature: 45 });
  s.bsb.params[1612] = { ...s.bsb.params[1612], value: '48.0' };
  const ack = await s.command('dhw-setpoint', 44);
  assert.match(ack.error, /consigne réduite de l'eau chaude du régulateur \(1612, 48 °C\)/);
  assert.match(ack.error, /au-dessus du plafond \(45 °C\)/);
  assert.doesNotMatch(ack.error, /plage permise/);
  assert.deepEqual(jsRequests(s.bsb), []);
});

test('M4: an unknown bus, or an ambiguous buswritable without a parameter access, refuses the commands', async (t) => {
  const params = bsbParams();
  delete params[700].readwrite;
  const s = await setup(t, {
    bsb: fakeBsbLan({ params, info: { ...bsbInfo(), buswritable: 7 } }),
  });
  assert.match(
    (await s.command('mode', 'reduced')).error,
    /ne dit pas si ce paramètre peut être écrit/,
  );
  s.bsb.info = { ...bsbInfo(), bus: 'XYZ' };
  await s.advance(31 * SECOND);
  assert.match(s.gladys.fake.connectionStatus.message.en, /did not name its bus/);
  assert.match((await s.command('mode', 'reduced')).error, /BSB ou LPB/);
  assert.deepEqual(jsRequests(s.bsb), []);
});

test('M5: the comfort setpoint never below the reduced setpoint (712)', async (t) => {
  const s = await setup(t);
  s.bsb.params[712] = { ...s.bsb.params[712], value: '19.0' };
  assert.match((await s.command('heating-setpoint', 18.5)).error, /entre 19 et 28 °C/);
  s.bsb.params[712] = { ...s.bsb.params[712], value: '---' };
  assert.match((await s.command('heating-setpoint', 21)).error, /plage permise/);
  assert.deepEqual(jsRequests(s.bsb), []);
});

test('HTTP 403 is about the credentials only (the firmware closes the connection on an IP)', async (t) => {
  const bsb = fakeBsbLan({ behave: () => ({ status: 403 }) });
  const s = await setup(t, { bsb, create: false, config: { address: HOST } });
  assert.match(
    s.gladys.fake.connectionStatus.message.fr,
    /HTTP 403\) : identifiant ou mot de passe/,
  );
  assert.doesNotMatch(s.gladys.fake.connectionStatus.message.en, /IP/);
});

test('M8: on a PPS bus the setpoint is a read-only feature', async (t) => {
  const bsb = fakeBsbLan({
    info: { ...bsbInfo(), bus: 'PPS' },
    params: {
      15000: { value: '0', desc: 'Auto', dataType: 1, unit: '' },
      15004: { value: '20.5', unit: '°C', dataType: 0 },
    },
  });
  const s = await setup(t, { bsb, create: false });
  const d = s.gladys.fake.discoveredDevices[0];
  const setpoint = d.features.find((f) => f.external_id === feature('room-setpoint'));
  assert.equal(setpoint.read_only, true);
  assert.equal(setpoint.category, 'temperature-sensor');
  assert.ok(d.features.every((f) => f.read_only));
});
