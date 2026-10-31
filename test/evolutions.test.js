// -----------------------------------------------------------------------------
// 0.2.0 (forum t/11458): heating circuit 2, the reduced setpoints, the hot
// water mode and reduced setpoint, the boiler, the read-only parameters of
// the configuration, the protective commands (Protection, hot water Off)
// and the read back that alone makes a success. SDK fake Gladys, fake
// BSB-LAN, mocked clock (the real one: test/realclock.test.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND, MINUTE } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  MAC_ID,
  NOW,
  bsbParams,
  fakeBsbLan,
  fullParams,
  inactive,
  settle,
} from './fixtures/fakeBsbLan.js';

const ALLOWED = { address: HOST, allow_commands: true };
const READ_ONLY = { address: HOST };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

async function setup(
  t,
  {
    config = ALLOWED,
    bsb = fakeBsbLan({ params: fullParams() }),
    store = memoryStore(),
    created,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const quiet = (...a) => logs.push(a.join(' '));
  const app = new BsbLanApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
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
  if (created) {
    // A device created by an earlier version.
    await gladys.fake.deviceCreated(created);
  }
  const connecting = gladys.connect();
  let up = false;
  connecting.then(() => (up = true));
  for (let i = 0; i < 100 && !up; i += 1) {
    await advance(100);
  }
  await connecting;
  t.after(() => app.stop());
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
  }
  await settle();
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role)) ?? {
      external_id: feature(role),
    };
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, bsb, advance, command, logs };
}

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const roles = (gladys) =>
  gladys.fake.discoveredDevices[0].features.map((f) => f.external_id.slice(device.length + 1));
const writes = (bsb) =>
  bsb.requests.filter((r) => r.endpoint === '/JS').map((r) => [r.body.Parameter, r.body.Value]);
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};

test('circuit 2, flows, hot water status and the boiler: read only features, values', async (t) => {
  const { gladys } = await setup(t, { config: READ_ONLY });
  for (const role of [
    'hc2-mode',
    'hc2-operating-mode',
    'hc2-status',
    'hc2-setpoint',
    'hc2-reduced-target',
    'hc2-flow-setpoint',
    'hc2-temperature-flow',
    'flow-setpoint',
    'temperature-flow',
    'dhw-status',
    'boiler-status',
    'temperature-boiler',
    'burner-stage-1',
    'burner-fault-s3',
    'last-fault-date',
    'last-fault-code',
  ]) {
    assert.ok(roles(gladys).includes(role), role);
  }
  assert.equal(last(gladys, 'hc2-mode'), 'automatic');
  assert.equal(last(gladys, 'hc2-setpoint'), 21);
  assert.equal(last(gladys, 'hc2-reduced-target'), 18);
  assert.equal(last(gladys, 'hc2-status'), 'Heating mode reduced');
  assert.equal(last(gladys, 'hc2-flow-setpoint'), 35);
  assert.equal(last(gladys, 'hc2-temperature-flow'), 34.1);
  assert.equal(last(gladys, 'flow-setpoint'), 45);
  assert.equal(last(gladys, 'temperature-flow'), 43.2);
  assert.equal(last(gladys, 'dhw-status'), 'Charging');
  assert.equal(last(gladys, 'boiler-status'), 'In operation');
  assert.equal(last(gladys, 'temperature-boiler'), 58.4);
  assert.equal(last(gladys, 'burner-stage-1'), 1);
  assert.equal(last(gladys, 'burner-fault-s3'), 0);
  assert.equal(last(gladys, 'last-fault-date'), '09.01.2026 12:42:02');
  assert.equal(last(gladys, 'last-fault-code'), '133 No flame established');
  const features = gladys.fake.discoveredDevices[0].features;
  const writable = features
    .filter((f) => !f.read_only)
    .map((f) => f.external_id.slice(device.length + 1));
  assert.deepEqual(writable.sort(), [
    'dhw-mode-select',
    'dhw-reduced-target',
    'dhw-setpoint',
    'hc2-mode',
    'hc2-reduced-target',
    'hc2-setpoint',
    'heating-reduced-target',
    'heating-setpoint',
    'mode',
  ]);
  assert.ok(
    features.every((f) => f.category !== 'switch' && !(f.type === 'binary' && !f.read_only)),
  );
  const dhwSelect = features.find((f) => f.external_id === feature('dhw-mode-select'));
  assert.deepEqual(
    dhwSelect.supported_options.map((o) => [o.value, o.label]),
    [
      ['on', 'Marche'],
      ['eco', 'Éco'],
      ['off', 'Arrêt'],
    ],
  );
});

test('circuit 2 absent ("---"): no feature, then its mode only, one parameter per poll', async (t) => {
  const params = fullParams();
  params[1000] = inactive('Operating mode HC2');
  const bsb = fakeBsbLan({ params });
  const { gladys, advance } = await setup(t, { bsb, config: READ_ONLY });
  assert.ok(!roles(gladys).some((r) => r.startsWith('hc2-')));
  const count = bsb.requests.length;
  await advance(31 * SECOND);
  const ids = bsb.requests.slice(count).flatMap((r) => r.ids);
  assert.ok(ids.includes('1000'));
  assert.ok(!ids.includes('1010') && !ids.includes('8001'));
  // Circuit 2 appears later: read whole again.
  bsb.params[1000] = fullParams()[1000];
  await advance(31 * SECOND);
  await advance(31 * SECOND);
  assert.ok(roles(gladys).includes('hc2-setpoint'));
});

test('reduced setpoints: within the protection one and the max, never above the comfort one', async (t) => {
  const { bsb, command } = await setup(t);
  // Circuit 1: 714 = 10, 716 = 28, comfort 710 = 20.
  assert.match((await command('heating-reduced-target', 20.5)).error, /entre 10 et 20 °C/);
  assert.match((await command('heating-reduced-target', 9.5)).error, /entre 10 et 20 °C/);
  assert.equal((await command('heating-reduced-target', 16.5)).success, true);
  // Circuit 2: 1014 = 8, 1016 = 26, comfort 1010 = 21, reduced 1012 = 18.
  assert.match((await command('hc2-reduced-target', 21.5)).error, /entre 8 et 21 °C/);
  assert.equal((await command('hc2-reduced-target', 17)).success, true);
  assert.match(
    (await command('hc2-setpoint', 16)).error,
    /entre 17 et 26 °C/,
    'comfort never below reduced',
  );
  assert.match((await command('hc2-setpoint', 26.5)).error, /entre 17 et 26 °C/);
  assert.equal((await command('hc2-setpoint', 22.5)).success, true);
  assert.deepEqual(writes(bsb), [
    ['712', '16.5'],
    ['1012', '17.0'],
    ['1010', '22.5'],
  ]);
  // The fresh read of a circuit 2 setpoint asks its mode too.
  const read = bsb.requests.filter((r) => r.endpoint === '/JQ' && r.ids.includes('1010')).at(-2);
  assert.deepEqual(read.ids, ['1000', '1010', '1012', '1014', '1016']);
});

test('hot water reduced setpoint: never above 1610, 1614, the ceiling nor 65 °C', async (t) => {
  const params = fullParams();
  params[1614] = { ...params[1614], value: '80.0' };
  params[1610] = { ...params[1610], value: '70.0' };
  const { bsb, command } = await setup(t, { bsb: fakeBsbLan({ params }) });
  assert.match((await command('dhw-reduced-target', 66)).error, /entre 10 et 65 °C/);
  // 1610 at 70 (the controller's), 1614 at 80: still 65 at most.
  assert.match((await command('dhw-reduced-target', 65.5)).error, /multiple de 1/);
  assert.equal((await command('dhw-reduced-target', 65)).success, true);
  assert.deepEqual(writes(bsb), [['1612', '65']]);
});

test('hot water reduced setpoint under the nominal one and the configured ceiling', async (t) => {
  const { bsb, command } = await setup(t, { config: { ...ALLOWED, dhw_max_temperature: 45 } });
  assert.match((await command('dhw-reduced-target', 46)).error, /plafonnée à 45 °C/);
  bsb.params[1610] = { ...bsb.params[1610], value: '42' };
  assert.match((await command('dhw-reduced-target', 44)).error, /entre 10 et 42 °C/);
  assert.equal((await command('dhw-reduced-target', 38)).success, true);
  assert.deepEqual(writes(bsb), [['1612', '38']]);
});

test('hot water mode: On and Eco behind the option; Off never held back', async (t) => {
  const { bsb, command, gladys } = await setup(t, { config: READ_ONLY });
  assert.match((await command('dhw-mode-select', 'eco')).error, /commandes sont désactivées/);
  assert.match((await command('dhw-mode-select', 'on')).error, /commandes sont désactivées/);
  const ack = await command('dhw-mode-select', 'off');
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(writes(bsb), [['1600', '0']]);
  assert.equal(last(gladys, 'dhw-mode-select'), 'off');
  // Never a fresh read nor a /JI before it: the write first, then its read back.
  const after = bsb.requests.slice(bsb.requests.findIndex((r) => r.endpoint === '/JS') - 1);
  assert.notEqual(after[0].endpoint, '/JI');
  assert.deepEqual(after[2].ids, ['1600']);
  assert.match((await command('dhw-mode-select', 'party')).error, /Mode inconnu/);
});

test('Protection of circuits 1 and 2: never held back by the option, a pause, a stop, another command', async (t) => {
  const store = memoryStore();
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app } = await setup(t, { config: READ_ONLY, bsb, store });
  // A 429 pause and a credentials stop, both held.
  app.memory.pausedUntil = Date.now() + 10 * MINUTE;
  app.memory.auth = { failures: 2, until: Date.now() + HOUR_MS };
  app.quietUntil = Date.now() + MINUTE;
  assert.equal((await command('mode', 'protection')).success, true);
  assert.equal((await command('hc2-mode', 'protection')).success, true);
  assert.deepEqual(writes(bsb), [
    ['700', '0'],
    ['1000', '0'],
  ]);
  assert.match((await command('mode', 'comfort')).error, /désactivées/);
});
const HOUR_MS = 60 * MINUTE;

test('Protection from an unknown mode code: left (it is the protective choice)', async (t) => {
  const params = fullParams();
  params[700] = { ...params[700], value: '7', desc: 'Special' };
  const { bsb, command } = await setup(t, { bsb: fakeBsbLan({ params }) });
  assert.match((await command('mode', 'comfort')).error, /ne connaît pas/);
  assert.equal((await command('mode', 'protection')).success, true);
  assert.deepEqual(writes(bsb), [['700', '0']]);
});

test('a protective command cancels a command not sent yet: nothing emitted before it leaves after it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance } = await setup(t, { bsb });
  bsb.behave = (r) => (r.endpoint === '/JQ' && r.ids.includes('710') ? { delay: 1200 } : undefined);
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  const f = (role) => d.features.find((x) => x.external_id === feature(role));
  let slow;
  let stop;
  gladys.fake.setValue(d, f('heating-setpoint'), 22).then((a) => (slow = a));
  await settle();
  await advance(300);
  gladys.fake.setValue(d, f('mode'), 'protection').then((a) => (stop = a));
  await settle();
  await advance(6 * SECOND);
  assert.match(slow.error, /commande de protection.*est arrivée après/);
  assert.equal(stop.success, true, JSON.stringify(stop));
  assert.deepEqual(writes(bsb), [['700', '0']]);
});

test('a protective command passes before the queued requests; BSB-LAN busy: queued, sent when free', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, command } = await setup(t, { bsb });
  // A poll request that takes 5 s on the adapter.
  bsb.behave = (r) => (r.endpoint === '/JQ' && r.ids[0] === '700' ? { delay: 5000 } : undefined);
  await advance(31 * SECOND);
  const ack = await command('dhw-mode-select', 'off', { wait: 4 * SECOND });
  assert.match(ack.error, /passe en tête et part dès qu'il est libre/);
  await advance(3 * SECOND);
  assert.deepEqual(writes(bsb), [['1600', '0']]);
  const i = bsb.requests.findIndex((r) => r.endpoint === '/JS');
  assert.deepEqual(
    bsb.requests[i - 1].ids.slice(0, 1),
    ['700'],
    'right after the request in flight',
  );
  assert.equal(last(gladys, 'dhw-mode-select'), 'off');
});

test('success only after a read back: accepted but unchanged is "not applied yet"', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command } = await setup(t, { bsb });
  // Status 1, the value never changes.
  bsb.behave = (r) =>
    r.endpoint === '/JS'
      ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 1 } }) }
      : undefined;
  const ack = await command('heating-setpoint', 22);
  assert.match(ack.error, /encore la précédente/);
  await command('heating-setpoint', 22, { wait: 5 * SECOND });
  // The read back fails: "sent, without confirmation", never a success.
  bsb.behave = (r) => {
    if (r.endpoint === '/JS') {
      return undefined;
    }
    return r.endpoint === '/JQ' && r.ids.length === 1 && r.ids[0] === '1610'
      ? { error: 'TIMEOUT', sent: true }
      : undefined;
  };
  const ack2 = await command('dhw-setpoint', 55);
  assert.match(ack2.error, /envoyée, sans confirmation.*not read back/);
});

test('a protective write a read shows not applied is written again, one per periodic read, 3 times at most', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, advance, app } = await setup(t, { bsb });
  bsb.behave = (r) =>
    r.endpoint === '/JS'
      ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 1 } }) }
      : undefined;
  const ack = await command('mode', 'protection');
  assert.match(ack.error, /encore la précédente/);
  // The follow-up reads (5 s, 20 s) never write it again.
  await advance(22 * SECOND);
  assert.deepEqual(writes(bsb), [['700', '0']]);
  // One write per periodic read (every 30 s), 3 at most, then kept, unsent.
  await advance(5 * MINUTE);
  assert.deepEqual(writes(bsb), Array(4).fill(['700', '0']));
  assert.equal(app.memory.stops.length, 1, 'still kept, never lifted by time');
  await advance(5 * MINUTE);
  assert.equal(writes(bsb).length, 4);
});

test('a protective command not applied, then another mode read twice at the boiler: lifted, never fought', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, advance, app } = await setup(t, { bsb });
  bsb.behave = (r) =>
    r.endpoint === '/JS'
      ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 1 } }) }
      : undefined;
  const ack = await command('hc2-mode', 'protection', { wait: SECOND });
  assert.match(ack.error, /encore la précédente/);
  bsb.params[1000] = { ...bsb.params[1000], value: '2', desc: 'Reduced' };
  await advance(2 * MINUTE);
  assert.deepEqual(writes(bsb), [['1000', '0']]);
  assert.deepEqual(app.memory.stops, []);
});

test('extra parameters: read only features as BSB-LAN describes them, never written', async (t) => {
  const params = fullParams();
  params[8326] = {
    name: 'Burner modulation',
    dataType_name: 'PERCENT',
    dataType_family: 'VALS',
    error: 0,
    value: '42',
    desc: '',
    dataType: 0,
    readwrite: 1,
    unit: '%',
  };
  params[8338] = {
    name: 'Hours run 1st stage',
    error: 0,
    value: '1234',
    desc: '',
    dataType: 0,
    readwrite: 1,
    unit: 'h',
  };
  params[8950] = {
    name: 'Common flow temp',
    error: 0,
    value: '40.5',
    desc: '',
    dataType: 0,
    readwrite: 1,
    unit: '°C',
  };
  params[5700] = {
    name: 'Presetting',
    error: 0,
    value: '2',
    desc: 'Two circuits',
    dataType: 1,
    readwrite: 0,
    unit: '',
  };
  const bsb = fakeBsbLan({ params });
  const { gladys, command, advance } = await setup(t, {
    bsb,
    config: { ...ALLOWED, extra_parameters: '8326, 8338;8950 5700 700 abc 8326' },
  });
  const features = gladys.fake.discoveredDevices[0].features;
  const f = (id) => features.find((x) => x.external_id === feature(`param-${id}`));
  assert.equal(f(8326).name, 'BSB 8326 Burner modulation (%)');
  assert.deepEqual(
    [f(8326).category, f(8326).type, f(8326).read_only],
    ['unknown', 'decimal', true],
  );
  assert.deepEqual(
    [f(8950).category, f(8950).type, f(8950).unit],
    ['temperature-sensor', 'probe', 'celsius'],
  );
  assert.deepEqual([f(5700).category, f(5700).type, f(5700).read_only], ['text', 'text', true]);
  assert.equal(last(gladys, 'param-8326'), 42);
  assert.equal(last(gladys, 'param-8338'), 1234);
  assert.equal(last(gladys, 'param-8950'), 40.5);
  assert.equal(last(gladys, 'param-5700'), 'Two circuits (2)');
  assert.match(message(gladys).fr, /ignorés.*700, abc, 8326/);
  // Never written, even writable on the controller and commands allowed.
  assert.match((await command('param-5700', '3')).error, /lecture seule/);
  assert.deepEqual(writes(bsb), []);
  // The type changes on the controller: never published as another kind.
  bsb.params[8326] = { ...bsb.params[8326], value: 'Off', dataType: 7 };
  await advance(31 * SECOND);
  assert.equal(last(gladys, 'param-8326'), 42);
});

test('a device created by 0.1.x keeps its read-only reduced setpoints, updated; new features added', async (t) => {
  const old = {
    name: 'Chauffage (BSB-LAN)',
    external_id: device,
    features: [
      {
        external_id: feature('heating-setpoint-reduced'),
        category: 'temperature-sensor',
        type: 'probe',
        read_only: true,
        name: 'Consigne réduite',
        unit: 'celsius',
        min: 0,
        max: 95,
      },
      {
        external_id: feature('dhw-setpoint-reduced'),
        category: 'temperature-sensor',
        type: 'probe',
        read_only: true,
        name: "Consigne réduite de l'eau chaude",
        unit: 'celsius',
        min: 0,
        max: 95,
      },
    ],
  };
  const { gladys, command } = await setup(t, { created: old });
  const r = roles(gladys);
  assert.ok(r.includes('heating-setpoint-reduced') && r.includes('heating-reduced-target'));
  assert.ok(r.includes('dhw-setpoint-reduced') && r.includes('dhw-reduced-target'));
  assert.equal(last(gladys, 'heating-setpoint-reduced'), 17);
  assert.equal(last(gladys, 'dhw-setpoint-reduced'), 40);
  assert.match((await command('heating-setpoint-reduced', 16)).error, /lecture seule/);
});

test('a controller without hot water: no hot water feature', async (t) => {
  const params = bsbParams();
  for (const id of ['1600', '1610', '1612', '1614', '8830', '8820']) {
    delete params[id];
  }
  const { gladys } = await setup(t, { bsb: fakeBsbLan({ params }), config: READ_ONLY });
  assert.ok(!roles(gladys).some((r) => r.startsWith('dhw') || r === 'temperature-dhw'));
});

test('a protective command passes before a command already queued', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, app } = await setup(t, { bsb });
  // A poll request that takes 1.5 s on the adapter, then a command, then Protection.
  bsb.behave = (r) =>
    r.endpoint === '/JQ' && r.ids[0] === '700' && r.ids.length === 4 ? { delay: 1500 } : undefined;
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  const f = (role) => d.features.find((x) => x.external_id === feature(role));
  const start = bsb.requests.length;
  app.tick();
  await settle();
  await advance(200);
  let first;
  let stop;
  gladys.fake.setValue(d, f('heating-setpoint'), 22).then((a) => (first = a));
  await settle();
  await advance(200);
  gladys.fake.setValue(d, f('mode'), 'protection').then((a) => (stop = a));
  await settle();
  await advance(6 * SECOND);
  const after = bsb.requests.slice(start).map((r) => `${r.endpoint}:${r.ids.join(',')}`);
  const js = after.indexOf('/JS:');
  assert.equal(after[js - 1], '/JQ:700,710,712,714', after.join(' '));
  assert.equal(stop.success, true);
  assert.match(first.error, /est arrivée après/);
});

test('the hot water bounds hold even past a broken configuration (65 °C at most)', async (t) => {
  const { app } = await setup(t);
  app.config.dhwCap = 70;
  const fresh = { dhwSetpoint: 70, dhwSetpointReduced: 40, dhwMax: 80 };
  for (const role of ['dhw-reduced-target', 'dhw-setpoint']) {
    assert.throws(() => app.checkRange(role, { value: 66 }, fresh), /entre/);
  }
});

test('feature ids: only our roles and param-<1 to 5 digits>', async () => {
  const { parseFeatureId } = await import('../src/devices.js');
  const base = `ext:x:bsblan:${MAC_ID}`;
  assert.equal(parseFeatureId(`${base}:param-8326`).role, 'param-8326');
  for (const role of ['param-0', 'param-123456', 'bogus', 'param-', 'param-12a']) {
    assert.equal(parseFeatureId(`${base}:${role}`), undefined, role);
  }
});

test('every published supported_options follows the core rules (text/select, both languages)', async (t) => {
  for (const language of ['fr', 'en']) {
    await t.test(language, async (t) => {
      const { gladys } = await setup(t, { config: { ...READ_ONLY, language } });
      const selects = gladys.fake.discoveredDevices[0].features.filter((f) => f.supported_options);
      assert.deepEqual(
        selects.map((f) => f.external_id.slice(device.length + 1)),
        ['mode', 'hc2-mode', 'dhw-mode-select'],
      );
      for (const f of selects) {
        assert.deepEqual([f.category, f.type], ['text', 'select']);
        const values = f.supported_options.map((o) => `${o.value}`);
        assert.equal(new Set(values).size, values.length, 'unique values');
        for (const option of f.supported_options) {
          assert.deepEqual(Object.keys(option).sort(), ['label', 'sort_order', 'value']);
          assert.equal(typeof option.label, 'string');
          assert.ok(option.label.length > 0 && option.label === option.label.trim(), option.label);
          assert.ok(typeof option.value === 'string' && option.value.trim().length > 0);
          assert.ok(Number.isInteger(option.sort_order));
        }
      }
    });
  }
});

test('hot water reduced setpoint: 1614 bounds it when below 1610 (out of order on the controller)', async (t) => {
  const params = fullParams();
  params[1610] = { ...params[1610], value: '60' };
  params[1614] = { ...params[1614], value: '55.0' };
  const { bsb, command } = await setup(t, { bsb: fakeBsbLan({ params }) });
  assert.match((await command('dhw-reduced-target', 57)).error, /entre 10 et 55 °C/);
  assert.equal((await command('dhw-reduced-target', 55)).success, true);
  assert.deepEqual(writes(bsb), [['1612', '55']]);
});

test('extra parameters: "0" refused; a plain number too long is never a text', async () => {
  const { extraParamsOf } = await import('../src/config.js');
  const { extraOf } = await import('../src/params.js');
  const parsed = extraParamsOf('0, 00, 7, 007');
  assert.deepEqual(parsed.ids, ['7']);
  assert.deepEqual(parsed.ignored, ['0', '00', '007']);
  assert.equal(
    extraOf({ name: 'x', error: 0, value: '9999999', dataType: 0, unit: 'Mois' }),
    undefined,
  );
  assert.equal(extraOf({ name: 'x', error: 0, value: 'abc', dataType_family: 'VALS' }), undefined);
});

test('hot water setpoints: refused when 1610, 1612 or 1614 is missing (never a NaN bound)', async (t) => {
  for (const missing of ['1610', '1612', '1614']) {
    await t.test(missing, async (t) => {
      const params = fullParams();
      delete params[missing];
      const { bsb, command } = await setup(t, { bsb: fakeBsbLan({ params }) });
      for (const [role, value] of [
        ['dhw-setpoint', 45],
        ['dhw-reduced-target', 35],
      ]) {
        assert.match((await command(role, value)).error, /plage permise|non envoyée/, role);
      }
      assert.deepEqual(writes(bsb), []);
    });
  }
});

test('extra parameters: at most 10', async () => {
  const { extraParamsOf } = await import('../src/config.js');
  const parsed = extraParamsOf('1,2,3,4,5,6,7,8,9,10,11,12');
  assert.equal(parsed.ids.length, 10);
  assert.deepEqual(parsed.ignored, ['11', '12']);
});
