// -----------------------------------------------------------------------------
// Kept stops (Protection on 700/1000, hot water Off on 1600): kept in /data
// until a read shows them applied; never abandoned while never sent; never
// lifted by time, only by a newer command that left or another mode read
// twice; sent first after a restart; /data never awaited on their path
// (frozen, unreadable). SDK fake Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

const READ_ONLY = { address: HOST };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;
const quiet = () => {};
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
/** Status 1, never applied: the controller ignores the write. */
const ignoring = (r) =>
  r.endpoint === '/JS'
    ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 1 } }) }
    : undefined;

async function setup(
  t,
  { config = READ_ONLY, bsb = fakeBsbLan({ params: fullParams() }), store = memoryStore() } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BsbLanApp({ gladys, logger, request: bsb.request, store, now: () => Date.now() });
  registerHandlers(gladys, app);
  const apps = [app];
  t.after(() => apps.forEach((a) => a.stop()));
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const until = async (promise) => {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200 && !done; i += 1) {
      await advance(100);
    }
    return promise;
  };
  await until(gladys.connect());
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
  }
  await settle();
  const command = async (role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(wait);
    return ack;
  };
  /** Another app on the same store and adapter: a restart of the container. */
  const restart = async () => {
    app.stop();
    const next = new BsbLanApp({
      gladys,
      logger,
      request: bsb.request,
      store,
      now: () => Date.now(),
    });
    apps.push(next);
    const count = bsb.requests.length;
    await until(next.start(config));
    return { next, after: bsb.requests.slice(count) };
  };
  return { gladys, app, bsb, advance, command, store, restart, until };
}

const writes = (bsb) =>
  bsb.requests.filter((r) => r.endpoint === '/JS').map((r) => [r.body.Parameter, r.body.Value]);
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};

test('kept in /data until a read shows it applied', async (t) => {
  const { bsb, command, store, advance, gladys } = await setup(t);
  bsb.behave = ignoring;
  assert.match((await command('mode', 'protection')).error, /encore la précédente/);
  assert.deepEqual(store.data.stops, [
    { mac: MAC_ID, role: 'mode', from: 'comfort', sent: 1, diff: 0 },
  ]);
  assert.match(message(gladys).fr, /envoyée\(s\), pas encore vue\(s\) appliquée\(s\)/);
  bsb.behave = undefined;
  await advance(40 * SECOND);
  assert.deepEqual(store.data.stops, []);
  assert.deepEqual(writes(bsb).at(-1), ['700', '0']);
});

test('a restart between two writes: the kept stop leaves first, before any read', async (t) => {
  const { bsb, command, store, restart, advance } = await setup(t);
  bsb.behave = ignoring;
  await command('mode', 'protection');
  await advance(6 * SECOND); // the follow-up read writes it again once
  assert.equal(store.data.stops[0].sent, 2);
  bsb.behave = undefined;
  const { after } = await restart();
  assert.equal(after[0].endpoint, '/JS', after.map((r) => r.endpoint).join(' '));
  assert.deepEqual([after[0].body.Parameter, after[0].body.Value], ['700', '0']);
  await advance(40 * SECOND);
  assert.deepEqual(store.data.stops, []);
});

test('a stop never sent is never abandoned: retried every 10 s, through hours, then sent', async (t) => {
  const { bsb, command, store, advance, gladys } = await setup(t);
  bsb.down = true;
  assert.match((await command('dhw-mode-select', 'off')).error, /non envoyée/);
  assert.equal(store.data.stops[0].sent, 0);
  assert.match(message(gladys).fr, /pas encore partie\(s\).*jamais abandonnée/);
  await advance(2 * 60 * MINUTE, SECOND);
  assert.deepEqual(bsb.writes(), [], 'nothing reached the adapter');
  assert.equal(store.data.stops.length, 1, 'never lifted by time');
  assert.equal(store.data.stops[0].sent, 0, 'a try that never left is not counted');
  // Tried every 10 s (about 720 in 2 h), never given up.
  const tries = bsb.requests.filter((r) => r.endpoint === '/JS').length;
  assert.ok(tries >= 600, String(tries));
  bsb.down = false;
  await advance(15 * SECOND);
  assert.deepEqual(bsb.writes(), [['1600', '0']]);
  await advance(40 * SECOND);
  assert.deepEqual(store.data.stops, []);
});

test('another mode set at the boiler, read twice, lifts the stop; never written against it', async (t) => {
  const { bsb, command, store, advance } = await setup(t);
  bsb.behave = ignoring;
  await command('mode', 'protection', { wait: SECOND });
  // Reduced, set at the boiler right after.
  bsb.params[700] = { ...bsb.params[700], value: '2', desc: 'Reduced' };
  await advance(5 * SECOND); // the first read
  assert.equal(store.data.stops.length, 1, 'one read is not enough');
  assert.equal(store.data.stops[0].diff, 1);
  await advance(16 * SECOND); // the second read
  assert.deepEqual(store.data.stops, []);
  await advance(2 * MINUTE);
  assert.deepEqual(writes(bsb), [['700', '0']]);
});

test('a newer command of the same role that left lifts the stop', async (t) => {
  const { bsb, command, store, advance } = await setup(t, {
    config: { address: HOST, allow_commands: true },
  });
  bsb.behave = ignoring;
  await command('hc2-mode', 'protection');
  bsb.behave = undefined;
  assert.equal(store.data.stops.length, 1);
  // Refused by the controller (status 2): not "left and accepted", kept.
  bsb.params[1000] = { ...bsb.params[1000], readwrite: 0 };
  assert.equal((await command('hc2-mode', 'reduced')).success, true);
  assert.deepEqual(store.data.stops, []);
  await advance(2 * MINUTE);
  assert.deepEqual(writes(bsb).at(-1), ['1000', '2'], JSON.stringify(writes(bsb)));
});

test('/data frozen: several stops in a row leave, each acked in time; the reads go on', async (t) => {
  const store = memoryStore();
  const { bsb, command, advance } = await setup(t, { store });
  store.frozen = true;
  const acks = [];
  for (const [role, value] of [
    ['mode', 'protection'],
    ['hc2-mode', 'protection'],
    ['dhw-mode-select', 'off'],
  ]) {
    acks.push(await command(role, value, { wait: 4 * SECOND }));
  }
  for (const ack of acks) {
    assert.equal(ack?.success, true, JSON.stringify(ack));
  }
  assert.deepEqual(writes(bsb), [
    ['700', '0'],
    ['1000', '0'],
    ['1600', '0'],
  ]);
  const count = bsb.requests.length;
  await advance(MINUTE);
  assert.ok(
    bsb.requests.slice(count).some((r) => r.endpoint === '/JI'),
    'polls go on',
  );
  assert.ok(store.attempts > 0);
});

test('/data unreadable: never overwritten; the stop leaves; its kept stops go once readable', async (t) => {
  const kept = { stops: [{ mac: MAC_ID, role: 'dhw-mode-select', sent: 0, diff: 0 }] };
  const store = memoryStore(kept, { unreadable: true });
  const { bsb, command, advance } = await setup(t, { store });
  assert.deepEqual(writes(bsb), [], 'its stop is not known yet');
  assert.equal((await command('mode', 'protection')).success, true);
  assert.deepEqual(writes(bsb), [['700', '0']]);
  assert.deepEqual(store.data, kept, 'never overwritten');
  assert.equal(store.attempts, 0);
  store.unreadable = false;
  await advance(40 * SECOND);
  assert.deepEqual(writes(bsb), [
    ['700', '0'],
    ['1600', '0'],
  ]);
  await advance(40 * SECOND);
  assert.deepEqual(store.data.stops, []);
});
