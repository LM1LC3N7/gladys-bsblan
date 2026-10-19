// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake BSB-LAN behind the injected HTTP transport. Timers and
// Date are mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  MAC_ID,
  NOW,
  bsbInfo,
  bsbParams,
  fakeBsbLan,
  inactive,
  ppsParams,
  settle,
} from './fixtures/fakeBsbLan.js';

const CONFIG = { address: HOST };
const ALLOWED = { address: HOST, allow_commands: true };
const device = (mac = MAC_ID) => `ext:test-integration:bsblan:${mac}`;
const feature = (role, mac = MAC_ID) => `${device(mac)}:${role}`;

async function setup(
  t,
  { config = CONFIG, bsb = fakeBsbLan(), create = true, store = memoryStore(), logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BsbLanApp({
    gladys,
    logger: recorder(logs),
    request: bsb.request,
    store,
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
  await advance(SECOND, 100);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  /** A command on a feature of the created device; resolves with the ack. */
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device());
    const target = d.features.find((f) => f.external_id === feature(role)) ?? {
      external_id: feature(role),
    };
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, bsb, advance, logs, command, store };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const discovered = (gladys, mac = MAC_ID) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === device(mac));
const roles = (d) => d.features.map((f) => f.external_id.slice(d.external_id.length + 1));
const transportOf = (gladys) =>
  gladys.fake.transports.filter((x) => x.device_external_id === device()).at(-1)?.transport;

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys } = await setup(t, { config: {}, bsb });
  assert.equal(bsb.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP de votre adaptateur BSB-LAN/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(bsb.requests.length, 0);
});

test('a configuration problem is said, never with a secret', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys } = await setup(t, {
    config: { address: 'http://admin:hunter2@192.168.1.50/1234/' },
    bsb,
  });
  assert.equal(bsb.requests.length, 0);
  assert.match(message(gladys).en, /user name and the password in their own fields/);
  assert.doesNotMatch(JSON.stringify(gladys.fake.connectionStatuses), /hunter2|admin|1234/);
});

test('one poll: /JI, /JV, then the parameters four at a time, POST, one request at a time', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys } = await setup(t, { bsb, create: false });
  assert.deepEqual(
    bsb.requests.map((r) => `${r.endpoint}${r.ids.length ? `:${r.ids.join(',')}` : ''}`),
    [
      '/JI',
      '/JV',
      '/JQ:700,710,712,714',
      '/JQ:716,8000,8740,8700',
      '/JQ:1600,1610,1612,1614',
      '/JQ:8830,8820,3113,6224',
    ],
  );
  assert.ok(bsb.requests.every((r) => r.options.method === 'POST' && r.options.port === 80));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    message(gladys).fr,
    /Connecté : RVS21\.831F\/127 sur le bus BSB \(BSB-LAN 5\.1\.0\)/,
  );
});

test('the passkey is the first part of the path; basic auth only with both fields', async (t) => {
  const bsb = fakeBsbLan({ passkey: 'k3y', auth: { username: 'admin', password: 's3cret!' } });
  const logs = [];
  const { gladys } = await setup(t, {
    bsb,
    logs,
    config: { address: HOST, passkey: 'k3y', username: 'admin', password: 's3cret!' },
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(bsb.requests.every((r) => r.path.startsWith('/k3y/')));
  assert.equal(
    bsb.requests[0].headers.authorization,
    `Basic ${Buffer.from('admin:s3cret!').toString('base64')}`,
  );
  const shown = JSON.stringify([
    logs,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
  ]);
  assert.doesNotMatch(shown, /k3y|s3cret|YWRtaW46/);
});

test('one device keyed by the MAC: the features its parameters gave, no switch, energy never an index', async (t) => {
  const { gladys } = await setup(t, { create: false });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  const d = discovered(gladys);
  assert.equal(d.name, 'Chauffage (BSB-LAN)');
  assert.equal(d.model, 'BSB-LAN RVS21.831F/127');
  assert.equal(d.should_poll, false);
  assert.deepEqual(d.params, [
    { name: 'mac', value: '00:80:41:19:69:90' },
    { name: 'bus', value: 'BSB' },
    { name: 'firmware', value: '5.1.0' },
    { name: 'controller', value: 'RVS21.831F/127' },
  ]);
  assert.deepEqual(roles(d), [
    'mode',
    'operating-mode',
    'heating-status',
    'heating-setpoint',
    'heating-setpoint-reduced',
    'temperature-room',
    'temperature-outdoor',
    'dhw-mode',
    'dhw-setpoint',
    'dhw-setpoint-reduced',
    'temperature-dhw',
    'dhw-pump',
    'energy-total',
  ]);
  const shape = Object.fromEntries(
    d.features.map((f) => [
      f.external_id.slice(d.external_id.length + 1),
      [f.category, f.type, f.unit ?? null, f.read_only, f.min, f.max],
    ]),
  );
  assert.deepEqual(shape.mode, ['text', 'select', null, false, 0, 0]);
  assert.deepEqual(shape['heating-setpoint'], [
    'thermostat',
    'target-temperature',
    'celsius',
    false,
    5,
    35,
  ]);
  assert.deepEqual(shape['dhw-setpoint'], [
    'water-heater',
    'target-temperature',
    'celsius',
    false,
    10,
    60,
  ]);
  assert.deepEqual(shape['temperature-room'], [
    'temperature-sensor',
    'decimal',
    'celsius',
    true,
    -60,
    120,
  ]);
  assert.deepEqual(shape['temperature-outdoor'][1], 'probe');
  assert.deepEqual(shape['dhw-pump'], ['unknown', 'binary', null, true, 0, 1]);
  assert.deepEqual(shape['energy-total'], ['unknown', 'decimal', null, true, 0, 100_000_000]);
  assert.ok(d.features.every((f) => f.category !== 'switch' && f.category !== 'energy-sensor'));
  assert.ok(d.features.filter((f) => !f.read_only).every((f) => f.type !== 'binary'));
  const select = d.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    select.supported_options.map((o) => [o.value, o.label]),
    [
      ['automatic', 'Automatique (programme horaire)'],
      ['comfort', 'Confort'],
      ['reduced', 'Réduit'],
      ['protection', 'Protection (hors-gel)'],
    ],
  );
});

test('the values of the created device, badge local', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(last(gladys, 'mode'), 'comfort');
  assert.equal(last(gladys, 'operating-mode'), 'Confort');
  assert.equal(last(gladys, 'heating-status'), 'Heating mode comfort');
  assert.equal(last(gladys, 'heating-setpoint'), 20);
  assert.equal(last(gladys, 'heating-setpoint-reduced'), 17);
  assert.equal(last(gladys, 'temperature-room'), 19.3);
  assert.equal(last(gladys, 'temperature-outdoor'), 7.6);
  assert.equal(last(gladys, 'dhw-mode'), 'Marche');
  assert.equal(last(gladys, 'dhw-setpoint'), 50);
  assert.equal(last(gladys, 'temperature-dhw'), 48.5);
  assert.equal(last(gladys, 'dhw-pump'), 1);
  assert.equal(last(gladys, 'energy-total'), 7968);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, []);
});

test('read every 30 s, the identification only once', async (t) => {
  const bsb = fakeBsbLan();
  const { advance } = await setup(t, { bsb });
  const count = bsb.requests.length;
  await advance(29 * SECOND);
  assert.equal(bsb.requests.length, count);
  await advance(3 * SECOND);
  const round = bsb.requests.slice(count).map((r) => r.endpoint);
  assert.deepEqual(round, ['/JI', '/JQ', '/JQ', '/JQ', '/JQ']);
  assert.ok(!bsb.requests.slice(count).some((r) => r.ids.includes('6224')));
});

test('the commands are refused while not allowed, and on a read-only feature', async (t) => {
  const bsb = fakeBsbLan();
  const { command } = await setup(t, { bsb });
  for (const [role, value] of [
    ['mode', 'automatic'],
    ['heating-setpoint', 21],
    ['dhw-setpoint', 50],
  ]) {
    const ack = await command(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /commandes sont désactivées/);
  }
  const ack = await command('temperature-room', 21);
  assert.match(ack.error, /lecture seule/);
  assert.deepEqual(bsb.writes(), []);
});

test('the mode: /JI then a fresh read of 700, then /JS 700; already so: nothing sent', async (t) => {
  const bsb = fakeBsbLan();
  const { command } = await setup(t, { bsb, config: ALLOWED });
  const before = bsb.requests.length;
  const ack = await command('mode', 'automatic');
  assert.equal(ack.success, true);
  const sent = bsb.requests.slice(before, before + 3);
  assert.deepEqual(
    sent.map((r) => r.endpoint),
    ['/JI', '/JQ', '/JS'],
  );
  assert.deepEqual(sent[1].ids, ['700']);
  assert.deepEqual(sent[2].body, { Parameter: '700', Value: '1', Type: '1' });
  assert.deepEqual(bsb.writes(), [['700', '1']]);
  await command('mode', 'automatic', { wait: 30 * SECOND });
  assert.equal((await command('mode', 'automatic')).success, true);
  assert.deepEqual(bsb.writes(), [['700', '1']], 'not sent again');
  assert.equal((await command('mode', 'off')).success, false, 'an exact key only');
});

test('an unknown mode of the controller is never left', async (t) => {
  const params = bsbParams();
  params[700] = { ...params[700], value: '7' };
  const bsb = fakeBsbLan({ params });
  const { command, gladys } = await setup(t, { bsb, config: ALLOWED });
  assert.equal(last(gladys, 'operating-mode'), 'Mode inconnu (7)');
  const ack = await command('mode', 'comfort');
  assert.match(ack.error, /Mode inconnu \(7\).*n'en sort pas/);
  assert.deepEqual(bsb.writes(), []);
});

test('the comfort setpoint: bounded by 714–716 read just before, strict values', async (t) => {
  const bsb = fakeBsbLan();
  const { command } = await setup(t, { bsb, config: ALLOWED });
  assert.equal((await command('heating-setpoint', 21.5)).success, true);
  assert.deepEqual(bsb.writes(), [['710', '21.5']]);
  await command('heating-setpoint', 21.5, { wait: 30 * SECOND });
  bsb.params[716] = { ...bsb.params[716], value: '24.0' };
  const high = await command('heating-setpoint', 26);
  assert.match(high.error, /entre 17 et 24 °C actuellement/, 'never below 712 nor 714');
  assert.match((await command('heating-setpoint', 16)).error, /entre 17 et 24/);
  for (const value of ['', null, 'abc', 21.55, '1e1', true]) {
    const ack = await command('heating-setpoint', value);
    assert.equal(ack.success, false, String(value));
  }
  bsb.params[714] = inactive();
  const missing = await command('heating-setpoint', 22);
  assert.match(missing.error, /plage permise/);
  assert.deepEqual(bsb.writes(), [['710', '21.5']]);
});

test('hot water: 55 °C by default, refused on arrival above it, bounded by 1612–1614', async (t) => {
  const bsb = fakeBsbLan();
  const { command, app } = await setup(t, { bsb, config: ALLOWED });
  const above = await command('dhw-setpoint', 56);
  assert.match(above.error, /plafonnée à 55 °C/);
  assert.equal((await command('dhw-setpoint', 61)).success, false, 'never above 60');
  assert.match((await command('dhw-setpoint', 50.5)).error, /multiple de 1 °C/);
  assert.match(
    (await command('dhw-setpoint', 39)).error,
    /entre 40 et 55 °C actuellement/,
    'the ceiling in the range shown',
  );
  const before = bsb.requests.length;
  assert.equal((await command('dhw-setpoint', 52)).success, true);
  assert.deepEqual(bsb.requests[before + 1].ids, ['1610', '1612', '1614']);
  assert.deepEqual(bsb.writes(), [['1610', '52']]);
  await command('dhw-setpoint', 52, { wait: 30 * SECOND });
  await app.configUpdated({ ...ALLOWED, dhw_max_temperature: 75 });
  assert.equal(app.config.dhwCap, 60, 'the ceiling never goes above 60');
  bsb.params[1614] = { ...bsb.params[1614], value: '58.0' };
  assert.match((await command('dhw-setpoint', 59)).error, /entre 40 et 58 °C/);
});

test('a ceiling lowered during the fresh read stops the command', async (t) => {
  let app;
  const bsb = fakeBsbLan({
    behave: (request) => {
      if (request.endpoint === '/JQ' && request.ids[0] === '1610') {
        app.configUpdated({ ...ALLOWED, dhw_max_temperature: 45 });
      }
      return undefined;
    },
  });
  const setup_ = await setup(t, { bsb, config: ALLOWED });
  app = setup_.app;
  const ack = await setup_.command('dhw-setpoint', 52);
  assert.match(ack.error, /plafonnée à 45 °C/);
  assert.deepEqual(bsb.writes(), []);
});

test('the option turned off during the fresh read stops the command', async (t) => {
  let app;
  const bsb = fakeBsbLan({
    behave: (request) => {
      if (request.endpoint === '/JQ' && request.ids[0] === '700' && request.ids.length === 1) {
        app.configUpdated(CONFIG);
      }
      return undefined;
    },
  });
  const s = await setup(t, { bsb, config: ALLOWED });
  app = s.app;
  const ack = await s.command('mode', 'reduced');
  assert.match(ack.error, /désactivées/);
  assert.deepEqual(bsb.writes(), []);
});

test('a write without answer: "sent, without confirmation", reads 5 s and 20 s later, guard', async (t) => {
  const bsb = fakeBsbLan({
    behave: (request) => (request.endpoint === '/JS' ? 'silent-applied' : undefined),
  });
  const { command, advance } = await setup(t, { bsb, config: ALLOWED });
  const before = bsb.requests.filter((r) => r.endpoint === '/JI').length;
  const ack = await command('mode', 'reduced', { wait: 4_900 });
  assert.ok(ack, 'answered within 5 s');
  assert.match(ack.error, /Commande envoyée, sans confirmation \(timeout\)/);
  assert.deepEqual(bsb.writes(), [['700', '2']]);
  await advance(5 * SECOND);
  const first = bsb.requests.filter((r) => r.endpoint === '/JI').length;
  assert.ok(first >= before + 1, 'a follow-up read 5 s later');
  await advance(15 * SECOND);
  const second = bsb.requests.filter((r) => r.endpoint === '/JI').length;
  assert.ok(second >= first + 1, 'another one 20 s later');
});

test('a guard: after an unconfirmed write, the value read is never taken for "already so"', async (t) => {
  const bsb = fakeBsbLan({
    behave: (request) => (request.endpoint === '/JS' ? 'timeout' : undefined),
  });
  const { command } = await setup(t, { bsb, config: ALLOWED });
  const sent = () => bsb.requests.filter((r) => r.endpoint === '/JS').length;
  assert.match((await command('mode', 'reduced', { wait: 4_400 })).error, /sans confirmation/);
  await command('mode', 'reduced', { wait: 3 * SECOND });
  // The controller still reads "comfort": the guard holds, the command leaves.
  const back = await command('mode', 'comfort', { wait: 4_400 });
  assert.match(back.error, /sans confirmation/);
  assert.ok(sent() >= 2);
  assert.deepEqual(bsb.requests.filter((r) => r.endpoint === '/JS').at(-1).body.Value, '3');
});

test('/JS status 2 is a refusal, status 0 or none "sent, without confirmation"', async (t) => {
  let status = 2;
  const bsb = fakeBsbLan({
    behave: (request) =>
      request.endpoint === '/JS' ? { raw: { [request.body.Parameter]: { status } } } : undefined,
  });
  const { command } = await setup(t, { bsb, config: ALLOWED });
  assert.match(
    (await command('mode', 'reduced')).error,
    /a refusé la commande \(BSB-LAN status 2\)/,
  );
  status = 0;
  await command('mode', 'reduced', { wait: 5 * SECOND });
  assert.match((await command('mode', 'reduced')).error, /sans confirmation \(no status 1\)/);
});

test('a write that never left is "not sent"; a 5xx after it left is unconfirmed', async (t) => {
  let mode = 'down';
  const bsb = fakeBsbLan({
    behave: (request) => {
      if (request.endpoint !== '/JS') {
        return undefined;
      }
      return mode === 'down' ? { error: 'unreachable', sent: false } : { status: 500, apply: true };
    },
  });
  const { command, advance } = await setup(t, { bsb, config: ALLOWED });
  assert.match((await command('mode', 'reduced')).error, /n'a pas pu être joint \(unreachable\)/);
  mode = 'five';
  await advance(5 * SECOND);
  assert.match((await command('mode', 'reduced')).error, /sans confirmation \(HTTP 500\)/);
  assert.deepEqual(bsb.writes(), [['700', '2']]);
  // A 5xx pauses every path.
  assert.match((await command('mode', 'comfort')).error, /en pause/);
});

test('a slow fresh read is refused unsent within 5 s', async (t) => {
  let slow = false;
  const bsb = fakeBsbLan({
    behave: (request) => (slow && request.endpoint === '/JQ' ? { delay: 10 * SECOND } : undefined),
  });
  const { command } = await setup(t, { bsb, config: ALLOWED });
  slow = true;
  const ack = await command('mode', 'reduced', { wait: 4_900 });
  assert.ok(ack, 'answered within 5 s');
  assert.match(ack.error, /trop lentement|relue juste avant/);
  assert.deepEqual(bsb.writes(), []);
});

test('a command waits for the poll request in flight, then passes before the next ones', async (t) => {
  let slowPoll = false;
  const bsb = fakeBsbLan({
    behave: (request) =>
      slowPoll && request.endpoint === '/JQ' && request.ids.length === 4
        ? { delay: 800 }
        : undefined,
  });
  const { command, advance } = await setup(t, { bsb, config: ALLOWED });
  slowPoll = true;
  await advance(30 * SECOND + 100, 100);
  const ack = await command('mode', 'reduced', { wait: 4 * SECOND });
  assert.equal(ack.success, true);
  const index = bsb.requests.findIndex((r) => r.endpoint === '/JS');
  assert.deepEqual(bsb.requests[index - 1].ids, ['700'], 'the fresh read just before the write');
});

test('one command at a time, and 3 s between two writes', async (t) => {
  const bsb = fakeBsbLan({
    behave: (request) => (request.endpoint === '/JS' ? 'silent-applied' : undefined),
  });
  const { gladys, advance } = await setup(t, { bsb, config: ALLOWED });
  const d = gladys.fake.devices[0];
  const mode = d.features.find((f) => f.external_id === feature('mode'));
  const setpoint = d.features.find((f) => f.external_id === feature('heating-setpoint'));
  const first = gladys.fake.setValue(d, mode, 'reduced');
  await settle();
  const second = await gladys.fake.setValue(d, setpoint, 22);
  assert.match(second.error, /encore en cours/);
  await advance(5 * SECOND, 100);
  assert.match((await first).error, /sans confirmation/);
});

test('credentials refused: a stop persisted, next tries 15 min then 1 h, never in a loop', async (t) => {
  const store = memoryStore();
  const bsb = fakeBsbLan({ auth: { username: 'admin', password: 'right' } });
  const config = { address: HOST, username: 'admin', password: 'wrong' };
  const { gladys, advance } = await setup(t, { bsb, config, store, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /refusé l'identifiant ou le mot de passe.*15 min/);
  assert.equal(store.data.auth.failures, 1);
  const left = store.data.auth.until - Date.now();
  assert.ok(left > 14 * MINUTE && left <= 15 * MINUTE, String(left));
  const count = bsb.requests.length;
  await advance(14 * MINUTE, 30 * SECOND);
  assert.equal(bsb.requests.length, count, 'nothing before 15 min');
  await advance(2 * MINUTE, 30 * SECOND);
  assert.equal(bsb.requests.length, count + 1, 'one try');
  assert.equal(store.data.auth.failures, 2);
  await advance(59 * MINUTE, MINUTE);
  assert.equal(bsb.requests.length, count + 1, 'then 1 h');
  // A reconnection to Gladys keeps the stop.
  await gladys.connect();
  await settle();
  assert.equal(bsb.requests.length, count + 1);
  assert.match(message(gladys).en, /refused the user name or the password/);
  // The right password, saved: tried at once, the stop lifted.
  const saved = gladys.fake.configUpdated({ ...config, password: 'right' });
  await advance(SECOND);
  await saved;
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.auth.failures, 0);
});

test('a stop persisted before a restart holds; the button tries now', async (t) => {
  const store = memoryStore({ auth: { failures: 1, until: NOW + 10 * MINUTE } });
  const bsb = fakeBsbLan();
  const { gladys, advance } = await setup(t, { bsb, store, create: false });
  assert.equal(bsb.requests.length, 0);
  assert.match(message(gladys).en, /asks for a user name and a password/);
  const pending = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(SECOND);
  const ack = await pending;
  assert.match(ack.data.message.en, /Connected/);
  assert.equal(store.data.auth.until, 0);
});

test('a stop read back from /data is bounded', async (t) => {
  const store = memoryStore({ auth: { failures: 3, until: NOW + 400 * HOUR }, pausedUntil: 'x' });
  const { app } = await setup(t, { store, create: false });
  assert.ok(app.memory.auth.until <= NOW + 24 * HOUR);
  assert.equal(app.memory.pausedUntil, 0);
});

test('HTTP 429: a pause from its Retry-After, persisted, for polls and commands', async (t) => {
  const store = memoryStore();
  let busy = false;
  const bsb = fakeBsbLan({
    behave: (request) =>
      busy && request.endpoint === '/JI'
        ? { status: 429, headers: { 'retry-after': '300' } }
        : undefined,
  });
  const { gladys, advance, command } = await setup(t, { bsb, store, config: ALLOWED });
  busy = true;
  await advance(31 * SECOND);
  assert.match(message(gladys).fr, /occupé ou en erreur.*5 min/);
  assert.ok(store.data.pausedUntil > Date.now());
  assert.match((await command('mode', 'reduced')).error, /en pause/);
  const count = bsb.requests.length;
  await gladys.connect();
  await settle();
  await advance(4 * MINUTE, 30 * SECOND);
  assert.equal(bsb.requests.length, count, 'the pause holds, a reconnection included');
  busy = false;
  await advance(2 * MINUTE, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('HTTP 5xx: a pause of 1 min at least', async (t) => {
  const store = memoryStore();
  let failing = false;
  const bsb = fakeBsbLan({
    behave: (request) => (failing && request.endpoint === '/JQ' ? { status: 503 } : undefined),
  });
  const { gladys, advance } = await setup(t, { bsb, store });
  failing = true;
  await advance(31 * SECOND);
  assert.match(message(gladys).en, /HTTP 429 or 5xx/);
  assert.ok(store.data.pausedUntil - Date.now() >= 55 * SECOND);
  // The main values keep their last one.
  assert.equal(last(gladys, 'temperature-room'), 19.3);
});

test('BSB-LAN unreachable: status, badge, mode text; retried after 30 s, 1, 2, 5 min', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys, advance, command, app } = await setup(t, { bsb, config: ALLOWED });
  bsb.down = true;
  await advance(30 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Lecture de BSB-LAN 192\.168\.1\.50 impossible \(unreachable/);
  assert.equal(last(gladys, 'operating-mode'), 'BSB-LAN injoignable');
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(last(gladys, 'temperature-room'), 19.3, 'the other values keep their last one');
  const count = bsb.requests.length;
  await advance(28 * SECOND);
  assert.equal(bsb.requests.length, count);
  await advance(2 * SECOND);
  assert.equal(bsb.requests.length, count + 1);
  assert.match((await command('mode', 'reduced')).error, /pas l'adaptateur lu actuellement/);
  bsb.down = false;
  await advance(MINUTE + SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
  assert.ok(app.live);
});

test('a wrong passkey (404) is said', async (t) => {
  const bsb = fakeBsbLan({ passkey: 'good' });
  const { gladys } = await setup(t, {
    bsb,
    config: { address: HOST, passkey: 'bad' },
    create: false,
  });
  assert.match(message(gladys).en, /HTTP 404\): check the passkey/);
  assert.doesNotMatch(JSON.stringify(gladys.fake.connectionStatuses), /bad|good/);
});

test('a firmware without /JV is not supported, read again every 30 min', async (t) => {
  const bsb = fakeBsbLan({ apiVersion: null });
  const { gladys, advance } = await setup(t, { bsb, create: false });
  assert.match(message(gladys).en, /JSON-API version/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  const count = bsb.requests.length;
  await advance(29 * MINUTE, 10 * SECOND);
  assert.equal(bsb.requests.length, count);
  await advance(MINUTE, 10 * SECOND);
  assert.ok(bsb.requests.length > count);
});

test('no MAC address: no device', async (t) => {
  const info = bsbInfo();
  delete info.MAC;
  const { gladys } = await setup(t, { bsb: fakeBsbLan({ info }), create: false });
  assert.match(message(gladys).en, /MAC address/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('another adapter at the address: its device apart, the created one "other"', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys, advance, command } = await setup(t, { bsb, config: ALLOWED });
  bsb.info = { ...bsb.info, MAC: '00:80:41:aa:bb:cc' };
  await advance(31 * SECOND);
  assert.equal(last(gladys, 'operating-mode'), 'Un autre adaptateur répond à cette adresse');
  assert.ok(discovered(gladys, '008041aabbcc'));
  assert.match(message(gladys).fr, /autre adaptateur/);
  assert.match((await command('mode', 'reduced')).error, /pas l'adaptateur lu actuellement/);
});

test('PPS: read only, commands refused', async (t) => {
  const bsb = fakeBsbLan({ params: ppsParams(), info: { ...bsbInfo(), bus: 'PPS' } });
  const { gladys, command } = await setup(t, { bsb, config: ALLOWED });
  const d = discovered(gladys);
  assert.ok(!roles(d).includes('mode'), 'no select on PPS');
  assert.ok(!roles(d).includes('heating-setpoint'), 'no writable thermostat on PPS');
  assert.ok(
    d.features.every((f) => f.read_only),
    'every PPS feature read only',
  );
  assert.equal(last(gladys, 'operating-mode'), 'Automatique (programme horaire)');
  assert.equal(last(gladys, 'room-setpoint'), 20.5);
  assert.equal(last(gladys, 'temperature-room'), 19.8);
  assert.match(message(gladys).fr, /Bus PPS : lecture seule/);
  assert.match((await command('heating-setpoint', 21)).error, /Bus PPS/);
  assert.deepEqual(bsb.writes(), []);
});

test('BSB-LAN in read-only mode (buswritable 0): commands refused, said', async (t) => {
  const bsb = fakeBsbLan({ info: { ...bsbInfo(), buswritable: 0 } });
  const { gladys, command } = await setup(t, { bsb, config: ALLOWED });
  assert.match(message(gladys).en, /read only/);
  assert.match((await command('mode', 'reduced')).error, /lecture seule/);
  assert.deepEqual(bsb.writes(), []);
});

test('a controller in °F: its temperatures are not shown', async (t) => {
  const params = bsbParams();
  params[8740] = { ...params[8740], unit: '&deg;F', value: '67.0' };
  const { gladys } = await setup(t, { bsb: fakeBsbLan({ params }) });
  assert.equal(last(gladys, 'temperature-room'), undefined);
  assert.match(message(gladys).en, /°F/);
});

test('a republished device never loses a feature', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys, advance } = await setup(t, { bsb });
  const before = roles(discovered(gladys));
  bsb.params[3113] = inactive();
  bsb.params[8820] = inactive();
  await advance(31 * SECOND);
  await gladys.fake.scanRequest();
  assert.deepEqual(roles(discovered(gladys)), before);
});

test('a reconnection to Gladys resends status, devices and badge, without a new read', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys } = await setup(t, { bsb });
  const devices = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const transports = gladys.fake.transports.length;
  const count = bsb.requests.length;
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, devices + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.transports.length > transports);
  assert.equal(bsb.requests.length, count);
});

test('the test button reads now, at most every 10 s', async (t) => {
  const bsb = fakeBsbLan();
  const { gladys, advance } = await setup(t, { bsb });
  const count = bsb.requests.length;
  const pending = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(SECOND, 100);
  const ack = await pending;
  assert.match(ack.data.message.fr, /Connecté : RVS21/);
  assert.ok(bsb.requests.length > count);
  const again = bsb.requests.length;
  const second = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(second.data.message.fr, /moins de 10 s/);
  assert.equal(bsb.requests.length, again);
});

test('logs never carry the passkey, the credentials nor the answers', async (t) => {
  const logs = [];
  const bsb = fakeBsbLan({
    passkey: 'Pk1',
    auth: { username: 'u', password: 'Pw-9' },
    behave: (request) =>
      request.endpoint === '/JS' ? { status: 500, body: 'secret 7968' } : undefined,
  });
  const { command } = await setup(t, {
    bsb,
    logs,
    config: { ...ALLOWED, passkey: 'Pk1', username: 'u', password: 'Pw-9' },
  });
  await command('mode', 'reduced', { wait: 5 * SECOND });
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every((l) => !/Pk1|Pw-9|7968|RVS21/.test(l)),
    logs.join('\n'),
  );
});
