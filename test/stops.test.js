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
import {
  HOST,
  MAC_ID,
  NOW,
  bsbInfo,
  fakeBsbLan,
  fullParams,
  settle,
} from './fixtures/fakeBsbLan.js';

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
  {
    config = READ_ONLY,
    bsb = fakeBsbLan({ params: fullParams() }),
    store = memoryStore(),
    request = bsb.request,
    connect = true,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BsbLanApp({ gladys, logger, request, store, now: () => Date.now() });
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
  if (!connect) {
    return { gladys, app, bsb, advance, store, until };
  }
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
      request,
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
  // The read back of its write is the reference "not applied" (Comfort).
  assert.deepEqual(store.data.stops, [
    { mac: MAC_ID, role: 'mode', address: HOST, sent: 1, after: 'comfort', diff: 0 },
  ]);
  assert.match(message(gladys).fr, /envoyée\(s\), pas encore vue\(s\) appliquée\(s\)/);
  bsb.behave = undefined;
  // The next periodic read (30 s after the follow-up of 20 s) writes it again.
  await advance(60 * SECOND);
  assert.deepEqual(store.data.stops, []);
  assert.deepEqual(writes(bsb), [
    ['700', '0'],
    ['700', '0'],
  ]);
});

test('a restart between two writes: the kept stop leaves first, before any read', async (t) => {
  const { bsb, command, store, restart, advance } = await setup(t);
  bsb.behave = ignoring;
  await command('mode', 'protection');
  await advance(55 * SECOND); // the periodic read writes it again once
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

// --- Review r1 (2026-10-31) ----------------------------------------------------

/** Status 0 ("set failed" on the bus): not applied. */
const failing = (r) =>
  r.endpoint === '/JS'
    ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 0 } }) }
    : undefined;
const statusOf = (code) => (r) =>
  r.endpoint === '/JS' ? { status: code, body: 'x', headers: { 'retry-after': '60' } } : undefined;

test('B1: a command that arrived BEFORE a stop never lifts it, whenever its answer comes', async (t) => {
  const { bsb, gladys, store, advance } = await setup(t, {
    config: { address: HOST, allow_commands: true },
  });
  // The Reduced write waits 800 ms for its answer; Protection is clicked meanwhile.
  bsb.behave = (r) => (r.endpoint === '/JS' && r.body.Value === '2' ? { delay: 800 } : undefined);
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  const f = (role) => d.features.find((x) => x.external_id === feature(role));
  let comfort;
  gladys.fake.setValue(d, f('mode'), 'reduced').then((a) => (comfort = a));
  await settle();
  // Until the Reduced write has left (its answer comes 800 ms later).
  for (let i = 0; i < 30 && !bsb.requests.some((r) => r.body?.Value === '2'); i += 1) {
    await advance(100);
  }
  await advance(100);
  let stop;
  gladys.fake.setValue(d, f('mode'), 'protection').then((a) => (stop = a));
  await settle();
  // The adapter drops before Protection leaves (the Comfort answer still comes).
  bsb.down = true;
  await advance(4 * SECOND);
  assert.match(comfort.error, /sans confirmation/, 'it left; its read back failed');
  assert.equal(stop.success, false);
  assert.equal(store.data.stops.length, 1, 'the stop clicked after the comfort write stays');
  assert.equal(store.data.stops[0].sent, 0);
  bsb.down = false;
  await advance(12 * SECOND);
  assert.deepEqual(bsb.writes().at(-1), ['700', '0']);
});

test('B2: clicked during the first read (nothing known before), status 0: kept, never "changed elsewhere"', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  bsb.behave = (r) => (r.endpoint === '/JI' ? { delay: 1500 } : failing(r));
  const { gladys, app, advance, until } = await setup(t, { bsb, connect: false });
  const connecting = gladys.connect();
  await advance(300);
  const id = (role) => `ext:test-integration:bsblan:${MAC_ID}:${role}`;
  let ack;
  app.setValue({ external_id: device }, { external_id: id('mode') }, 'protection').then(
    () => (ack = 'ok'),
    (e) => (ack = e.message),
  );
  await until(connecting);
  await advance(25 * SECOND);
  assert.ok(ack, 'answered');
  assert.equal(
    app.memory.stops.length,
    1,
    'kept: Automatic is what is left after it, not a change',
  );
  // The next periodic read writes it again.
  await advance(40 * SECOND);
  assert.ok(bsb.requests.filter((r) => r.endpoint === '/JS').length >= 2);
  assert.equal(app.memory.stops.length, 1);
});

test('B2: memory says Protection (old), the room unit set Automatic: status 0 keeps the stop, resent', async (t) => {
  const params = fullParams();
  params[700] = { ...params[700], value: '0', desc: 'Protection' };
  const bsb = fakeBsbLan({ params });
  const { command, app, advance } = await setup(t, { bsb });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  bsb.behave = failing;
  await command('mode', 'protection');
  await advance(25 * SECOND);
  assert.equal(app.memory.stops.length, 1, 'never lifted on the old Protection nor on Automatic');
  await advance(40 * SECOND);
  assert.equal(writes(bsb).length, 2, 'written again by a periodic read');
  assert.equal(app.memory.stops.length, 1);
});

test('B2: memory stale (Automatic), Comfort set at the unit before the click: kept, resent', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app, advance } = await setup(t, { bsb });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  await advance(31 * SECOND);
  bsb.params[700] = { ...bsb.params[700], value: '3', desc: 'Comfort' };
  bsb.behave = failing;
  await command('mode', 'protection');
  await advance(25 * SECOND);
  assert.equal(app.memory.stops.length, 1);
  assert.equal(app.memory.stops[0].after, 'comfort');
});

test('B2 (s3k): never "applied" on a value read before the click, nor on another role', async (t) => {
  const params = fullParams();
  params[700] = { ...params[700], value: '0', desc: 'Protection' };
  params[1000] = { ...params[1000], value: '0', desc: 'Protection' };
  const bsb = fakeBsbLan({ params });
  const { gladys, app, advance, store } = await setup(t, {
    bsb,
    config: { address: HOST, allow_commands: true },
  });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  bsb.params[1000] = { ...bsb.params[1000], value: '1', desc: 'Automatic' };
  // A hot water command reads (800 ms); Protection of circuit 2 is clicked meanwhile.
  bsb.behave = (r) =>
    r.endpoint === '/JQ' && r.ids.join(',') === '1610,1612,1614' ? { delay: 800 } : undefined;
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  const f = (role) => d.features.find((x) => x.external_id === feature(role));
  gladys.fake.setValue(d, f('dhw-setpoint'), 52);
  await settle();
  await advance(100);
  gladys.fake.setValue(d, f('hc2-mode'), 'protection');
  await settle();
  await advance(300);
  bsb.down = true;
  await advance(3 * SECOND);
  assert.deepEqual(
    app.memory.stops.map((k) => k.role),
    ['hc2-mode'],
    'not lifted by the hot water read nor by the old 1000',
  );
  assert.equal(store.data.stops[0].sent, 0);
});

test('I1: a stop kept for adapter A is never written to adapter B at a new address; held, said', async (t) => {
  const a = fakeBsbLan({ params: fullParams() });
  const b = fakeBsbLan({
    params: fullParams(),
    info: { ...bsbInfo(), MAC: '11:22:33:44:55:66' },
  });
  const request = (o) => (o.host === '192.168.1.60' ? b.request(o) : a.request(o));
  const { app, command, advance, gladys, until } = await setup(t, { bsb: a, request });
  a.down = true;
  await command('mode', 'protection');
  assert.equal(app.memory.stops.length, 1);
  await until(app.configUpdated({ address: '192.168.1.60' }));
  await advance(2 * MINUTE);
  assert.deepEqual(b.writes(), [], 'never written to B');
  assert.equal(b.requests[0].endpoint, '/JI', 'B: its MAC read first');
  assert.equal(app.memory.stops.length, 1, 'held, not dropped');
  assert.match(gladys.fake.connectionStatus.message.fr, /gardée\(s\) pour un autre adaptateur/);
  // Back to A, which answers again: sent there.
  a.down = false;
  await until(app.configUpdated({ address: HOST }));
  await advance(15 * SECOND);
  assert.deepEqual(a.writes().at(-1), ['700', '0']);
});

test('I1: after a restart, a kept stop goes first only to its own address', async (t) => {
  const store = memoryStore({
    stops: [{ mac: MAC_ID, role: 'mode', address: HOST, sent: 0, diff: 0 }],
  });
  const bsb = fakeBsbLan({ params: fullParams() });
  await setup(t, { bsb, store });
  assert.equal(bsb.requests[0].endpoint, '/JS');
  assert.deepEqual(bsb.writes()[0], ['700', '0']);
});

test('I2: an old stop read from an unreadable /data never overrides a newer command of its role', async (t) => {
  const store = memoryStore(
    { stops: [{ mac: MAC_ID, role: 'mode', address: HOST, sent: 0, diff: 0 }] },
    { unreadable: true },
  );
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, advance } = await setup(t, {
    bsb,
    store,
    config: { address: HOST, allow_commands: true },
  });
  assert.equal((await command('mode', 'reduced')).success, true);
  store.unreadable = false;
  await advance(2 * MINUTE);
  assert.deepEqual(bsb.writes(), [['700', '2']]);
  assert.deepEqual(store.data.stops, []);
});

test('I3 (S5): a newer command refused (401, 429) never lifts a stop; a 401 or 429 on a stop is not a try', async (t) => {
  for (const code of [401, 429]) {
    await t.test(String(code), async (t) => {
      const { bsb, command, app } = await setup(t, {
        config: { address: HOST, allow_commands: true },
      });
      bsb.behave = statusOf(code);
      await command('mode', 'protection');
      assert.equal(app.memory.stops[0].sent, 0, `${code} on the stop: not a try`);
      // The newer command: the 429/401 stop and pause are lifted for it to leave.
      app.memory.pausedUntil = 0;
      app.memory.auth = { failures: 0, until: 0 };
      await command('mode', 'reduced');
      assert.equal(app.memory.stops.length, 1, `${code} on a newer command: kept`);
    });
  }
});

test('I3 (S6): a newer command refused by BSB-LAN (status 2) never lifts a stop', async (t) => {
  const { bsb, command, app } = await setup(t, {
    config: { address: HOST, allow_commands: true },
  });
  bsb.behave = ignoring;
  await command('mode', 'protection');
  bsb.behave = (r) =>
    r.endpoint === '/JS'
      ? { status: 200, body: JSON.stringify({ 700: { status: 2 } }) }
      : undefined;
  await command('mode', 'reduced');
  assert.equal(app.memory.stops.length, 1);
});

test('I3 (S7, S8): refused credentials hold an unsent stop (no try every 10 s); the check lives on and sends it once accepted', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams(), auth: { username: 'u', password: 'p' } });
  const { command, app, advance } = await setup(t, {
    bsb,
    config: { address: HOST, username: 'u', password: 'p' },
  });
  bsb.auth = { username: 'u', password: 'other' };
  await advance(31 * SECOND);
  assert.ok(app.memory.auth.until > Date.now(), 'credentials refused');
  await command('mode', 'protection');
  const tries = bsb.requests.filter((r) => r.endpoint === '/JS').length;
  assert.equal(tries, 1, 'the click itself, once');
  await advance(5 * MINUTE, SECOND);
  assert.equal(
    bsb.requests.filter((r) => r.endpoint === '/JS').length,
    1,
    'held: no try every 10 s',
  );
  assert.equal(app.memory.stops[0].sent, 0);
  // The adapter accepts the credentials again: the read at the end of the
  // stop (1 h after the second refusal) succeeds, and the check sends it.
  bsb.auth = { username: 'u', password: 'p' };
  await advance(70 * MINUTE, 5 * SECOND);
  assert.deepEqual(bsb.writes().at(-1), ['700', '0']);
});

test('I3 (S15): /data frozen at start: started within the bounded waits, polls and stops go', async (t) => {
  const store = memoryStore(null, { frozen: true });
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, app, advance } = await setup(t, { bsb, store, connect: false });
  let started = false;
  gladys.connect().then(() => (started = true));
  await advance(6 * SECOND);
  assert.ok(started, 'start() bounded');
  assert.ok(bsb.requests.some((r) => r.endpoint === '/JQ'));
  assert.ok(app.live);
});

test('getConfig() failing when connected: said, tried again, then started', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, app, advance } = await setup(t, { bsb, connect: false });
  const real = gladys.getConfig.bind(gladys);
  // The SDK reads it once to connect; our handler's next two reads fail.
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2 || calls === 3) {
      throw new Error('timeout');
    }
    return real();
  };
  gladys.connect();
  await advance(SECOND);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /configuration de l'intégration n'a pas pu être lue/,
  );
  assert.equal(bsb.requests.length, 0);
  await advance(25 * SECOND);
  assert.ok(app.live, 'started after the third try');
});

test('Protection on a device of another adapter (another MAC read): refused, nothing kept', async (t) => {
  const { app, bsb } = await setup(t);
  const other = 'ext:test-integration:bsblan:aabbccddeeff';
  const answer = await app
    .setValue({ external_id: other }, { external_id: `${other}:mode` }, 'protection')
    .then(
      () => 'ok',
      (err) => err.message,
    );
  assert.match(answer, /pas l'adaptateur lu actuellement/);
  assert.deepEqual(app.memory.stops, []);
  assert.deepEqual(bsb.writes(), []);
});

test('B2: a read that left before the write never sets "not applied" nor counts as a change', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app, advance } = await setup(t, { bsb });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  await advance(35 * SECOND);
  // Clicked: never leaves (unreachable); retried 10 s later.
  bsb.behave = (r) => (r.endpoint === '/JS' ? { error: 'unreachable', sent: false } : undefined);
  await command('mode', 'protection', { wait: SECOND });
  assert.equal(app.memory.stops[0].sent, 0);
  // Just before the retry, a read starts: its batch of 700 reads Automatic,
  // then the room unit sets Comfort; its next batch is slow, the retry
  // passes between the two and fails on the bus (status 0, no read back).
  bsb.behave = (r) => {
    if (r.endpoint === '/JQ' && r.ids[0] === '700' && r.ids.length === 4) {
      setTimeout(() => {
        bsb.params[700] = { ...bsb.params[700], value: '3', desc: 'Comfort' };
      }, 60);
      return undefined;
    }
    if (r.endpoint === '/JQ' && r.ids[0] === '716') {
      return { delay: 1500 };
    }
    return failing(r);
  };
  await advance(8 * SECOND);
  app.tick();
  await settle();
  await advance(3 * SECOND);
  assert.equal(app.memory.stops[0].sent, 1, 'the retry left during that read');
  await advance(25 * SECOND);
  assert.equal(app.memory.stops.length, 1, 'kept: Comfort is what stays after it');
  assert.equal(app.memory.stops[0].after, 'comfort');
});

test('B2: two different modes in a row are not "another mode read twice"', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app, advance } = await setup(t, { bsb });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  await advance(35 * SECOND);
  bsb.behave = failing;
  await command('mode', 'protection', { wait: SECOND });
  await advance(5 * SECOND); // follow-up at 5 s: Automatic, the reference
  assert.equal(app.memory.stops[0].after, 'automatic');
  bsb.params[700] = { ...bsb.params[700], value: '3', desc: 'Comfort' };
  await advance(15 * SECOND); // follow-up at 20 s: Comfort (once)
  bsb.params[700] = { ...bsb.params[700], value: '2', desc: 'Reduced' };
  await advance(32 * SECOND); // periodic: Reduced (once)
  assert.equal(app.memory.stops.length, 1);
  await advance(31 * SECOND); // Reduced again: twice in a row
  assert.deepEqual(app.memory.stops, []);
});

test('I1: a stop queued while /JI shows another adapter at the address is not written to it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app, advance } = await setup(t, { bsb });
  // Its writes never leave until the next /JI starts.
  let jiStarted = false;
  bsb.behave = (r) => {
    if (r.endpoint === '/JI') {
      jiStarted = true;
      // Another adapter now answers at the address; its /JI is slow (12 s):
      // the 10 s retry of the stop queues behind it.
      bsb.info = { ...bsb.info, MAC: '11:22:33:44:55:66' };
      return { delay: 12_000 };
    }
    return r.endpoint === '/JS' && !jiStarted ? { error: 'unreachable', sent: false } : undefined;
  };
  await command('mode', 'protection');
  assert.equal(app.memory.stops[0].sent, 0);
  await advance(90 * SECOND);
  assert.deepEqual(bsb.writes(), [], 'never written to the other adapter');
  assert.equal(app.memory.stops.length, 1, 'kept for its own adapter');
});

// --- Review r2 (2026-10-31) ----------------------------------------------------

/** The answer of a /JQ as the adapter has it now (to freeze it before a delay). */
const snapshot = (bsb, ids) =>
  Object.fromEntries(
    ids.filter((id) => Object.hasOwn(bsb.params, id)).map((id) => [id, bsb.params[id]]),
  );

// A command of the role that never left, or left refused: the marking rule
// (`touched` only in left() and keepStop) on each path (mutants T2-T5, T7 of r3).
const NEVER_LEFT = [
  { name: 'option off', allow: false, value: 'reduced', ack: /désactivées/ },
  { name: 'refused before the controller (HTTP 400)', behave: statusOf(400), ack: /a refusé.*400/ },
  {
    name: 'refused by BSB-LAN (status 2)',
    behave: (r) =>
      r.endpoint === '/JS'
        ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 2 } }) }
        : undefined,
    ack: /a refusé.*status 2/,
  },
  {
    name: 'not sent (unreachable)',
    behave: (r) => (r.endpoint === '/JS' ? { error: 'unreachable', sent: false } : undefined),
    ack: /non envoyée/,
  },
  // Comfort already (700 = 3): nothing sent.
  { name: 'already so', value: 'comfort', ack: null },
];

test('r2 T1: an old stop from /data is never dropped by a command of its role that never left', async (t) => {
  for (const { name, allow = true, value = 'reduced', behave, ack } of NEVER_LEFT) {
    await t.test(name, async (t) => {
      const store = memoryStore(
        { stops: [{ mac: MAC_ID, role: 'mode', address: HOST, sent: 0, diff: 0 }] },
        { unreadable: true },
      );
      const bsb = fakeBsbLan({ params: fullParams() });
      const { command, advance, app } = await setup(t, {
        bsb,
        store,
        config: { address: HOST, allow_commands: allow },
      });
      bsb.behave = behave;
      const answer = await command('mode', value);
      if (ack) {
        assert.match(answer.error, ack);
      } else {
        assert.equal(answer.success, true);
      }
      assert.deepEqual(bsb.writes(), [], 'nothing applied');
      bsb.behave = undefined;
      store.unreadable = false;
      await advance(45 * SECOND);
      assert.deepEqual(bsb.writes(), [['700', '0']]);
      assert.deepEqual(app.memory.stops, [], 'sent, then seen applied');
    });
  }
});

test('r2 C1: a batch that left before the click (still Protection) never lifts the stop "applied"', async (t) => {
  const params = fullParams();
  params[700] = { ...params[700], value: '0', desc: 'Protection' };
  const bsb = fakeBsbLan({ params });
  const { gladys, app, advance } = await setup(t, { bsb });
  // The next read: its batch of 700 leaves (Protection), answers 1 s later;
  // meanwhile the room unit sets Automatic and Protection is clicked; its
  // first write is cut after it left.
  let armed = true;
  let cut = true;
  bsb.behave = (r) => {
    if (armed && r.endpoint === '/JQ' && r.ids[0] === '700' && r.ids.length === 4) {
      armed = false;
      return { delay: 1000, raw: snapshot(bsb, r.ids) };
    }
    if (r.endpoint === '/JS' && cut) {
      cut = false;
      return { error: 'unreachable', sent: true };
    }
    return undefined;
  };
  app.tick();
  await settle();
  for (let i = 0; i < 20 && armed; i += 1) {
    await advance(100);
  }
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  gladys.fake.setValue(
    d,
    d.features.find((x) => x.external_id === feature('mode')),
    'protection',
  );
  await settle();
  await advance(3 * SECOND);
  assert.equal(app.memory.stops.length, 1, 'not lifted by the batch that left before the click');
  await advance(60 * SECOND);
  assert.equal(bsb.params[700].value, '0', 'written again by a periodic read, applied');
});

test('r2 O6: one read never counts twice (a command read, then the poll that takes it over)', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, app, advance } = await setup(t, {
    bsb,
    config: { address: HOST, allow_commands: true },
  });
  bsb.params[700] = { ...bsb.params[700], value: '1', desc: 'Automatic' };
  await advance(35 * SECOND);
  bsb.behave = failing;
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  const f = (role) => d.features.find((x) => x.external_id === feature(role));
  gladys.fake.setValue(d, f('mode'), 'protection');
  await settle();
  await advance(6 * SECOND);
  assert.equal(app.memory.stops[0].after, 'automatic');
  // Comfort at the unit, 700 read only now. A poll: its second batch is
  // slow; a mode command passes between its batches, reads 700 (Comfort,
  // once), is refused (read only); the poll then takes that read over.
  bsb.params[700] = { ...bsb.params[700], value: '3', desc: 'Comfort', readwrite: 1 };
  bsb.behave = (r) => (r.endpoint === '/JQ' && r.ids[0] === '716' ? { delay: 1500 } : failing(r));
  app.tick();
  await settle();
  await advance(300);
  let refused;
  gladys.fake.setValue(d, f('mode'), 'reduced').then((a) => (refused = a));
  await settle();
  await advance(5 * SECOND);
  assert.match(refused.error, /lecture seule/);
  assert.equal(app.memory.stops.length, 1, 'one read of Comfort: not twice');
  assert.equal(app.memory.stops[0].diff, 1);
});

test('r2 O7: a stop that never left takes no reference and is never lifted as "another mode"', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, app, advance } = await setup(t, { bsb });
  bsb.behave = (r) => (r.endpoint === '/JS' ? { error: 'unreachable', sent: false } : undefined);
  await command('mode', 'protection');
  bsb.params[700] = { ...bsb.params[700], value: '2', desc: 'Reduced' };
  await advance(2 * MINUTE);
  assert.equal(app.memory.stops.length, 1);
  assert.equal(app.memory.stops[0].sent, 0);
  assert.equal(app.memory.stops[0].after, undefined);
});

test('r2 N12: after a credentials hold, a stop never sent leaves through a 5xx pause', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams(), auth: { username: 'u', password: 'p' } });
  const { command, advance, app } = await setup(t, {
    bsb,
    config: { address: HOST, username: 'u', password: 'p' },
  });
  bsb.auth = { username: 'u', password: 'other' };
  await advance(31 * SECOND);
  await command('mode', 'protection');
  assert.equal(app.memory.stops[0].sent, 0);
  // Credentials back, but every read answers 503 (a pause, reads halted);
  // a write is accepted.
  bsb.auth = { username: 'u', password: 'p' };
  bsb.behave = (r) => (r.endpoint === '/JS' ? undefined : { status: 503, body: 'busy' });
  await advance(80 * MINUTE, 5 * SECOND);
  assert.deepEqual(bsb.writes(), [['700', '0']]);
});

test('r2 O18: a stop held for its MAC leaves right after the /JI that shows it, before the rest of the read', async (t) => {
  const store = memoryStore({
    stops: [{ mac: MAC_ID, role: 'mode', address: '10.9.9.9', sent: 0, diff: 0 }],
  });
  const bsb = fakeBsbLan({ params: fullParams() });
  bsb.behave = (r) => (r.endpoint === '/JQ' ? { delay: 1000 } : undefined);
  await setup(t, { bsb, store });
  const order = bsb.requests.map((r) => r.endpoint);
  assert.equal(order[0], '/JI', 'held until its MAC is read');
  const js = order.indexOf('/JS');
  assert.ok(js !== -1 && js <= 3, order.slice(0, 6).join(' '));
});

test('r2 O20: a stop kept from before a restart is sent once at start, then only by periodic reads', async (t) => {
  const store = memoryStore({
    stops: [{ mac: MAC_ID, role: 'mode', address: HOST, sent: 1, diff: 0 }],
  });
  const bsb = fakeBsbLan({ params: fullParams() });
  bsb.behave = ignoring;
  const { advance } = await setup(t, { bsb, store });
  await advance(25 * SECOND);
  assert.equal(writes(bsb).length, 1, 'once at start, not every 10 s');
});

test('r2: an old stop read late from /data never repeats a Protection of this run already applied', async (t) => {
  const store = memoryStore(
    { stops: [{ mac: MAC_ID, role: 'mode', address: HOST, sent: 0, diff: 0 }] },
    { unreadable: true },
  );
  const bsb = fakeBsbLan({ params: fullParams() });
  const { command, advance } = await setup(t, { bsb, store });
  assert.equal((await command('mode', 'protection')).success, true);
  // Changed at the room unit afterwards.
  bsb.params[700] = { ...bsb.params[700], value: '3', desc: 'Comfort' };
  store.unreadable = false;
  await advance(45 * SECOND);
  assert.deepEqual(bsb.writes(), [['700', '0']]);
  assert.equal(bsb.params[700].value, '3');
});
