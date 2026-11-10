// -----------------------------------------------------------------------------
// Forum t/11458 n° 9 (XDECO, 0.3.2) and the minors of review bsblan-032-r3:
// a command that waits, or that a newer value replaced, is logged as info,
// each with its own line; a failure to send to Gladys is logged once per
// outage, then once when it works again; a refusal under the mark guard gets
// its own 10 minutes (m1); the read-only twins of a setting are held with it
// (m2). SDK fake Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { StatePublisher } from '../src/publisher.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

const ALLOWED = { address: HOST, allow_commands: true };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;
const MINUTE = 60 * SECOND;

/** A logger that keeps `[level, line]`. */
const recorder = (lines) => {
  const at =
    (level) =>
    (...args) =>
      lines.push([level, args.map(String).join(' ')]);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

/** The read-only probes of 712 and 1612 that a device created by 0.1.x still has. */
const legacyProbe = (role) => ({
  external_id: feature(role),
  category: 'temperature-sensor',
  type: 'probe',
  read_only: true,
  name: role,
  unit: 'celsius',
  min: 0,
  max: 95,
});

async function setup(t, { bsb = fakeBsbLan({ params: fullParams() }), legacy = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const lines = [];
  const logger = recorder(lines);
  const gladys = createFakeGladys({ config: ALLOWED });
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  // The wiring of index.js, with the same logger.
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  let up = false;
  connecting.then(() => (up = true));
  for (let i = 0; i < 100 && !up; i += 1) {
    await advance(100);
  }
  await connecting;
  for (const d of [...gladys.fake.discoveredDevices]) {
    const extra = legacy
      ? ['heating-setpoint-reduced', 'dhw-setpoint-reduced'].map(legacyProbe)
      : [];
    await gladys.fake.deviceCreated({ ...d, features: [...d.features, ...extra] });
  }
  await advance(2 * SECOND);
  const click = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    const box = {};
    gladys.fake.setValue(d, target, value).then((a) => (box.ack = a));
    return box;
  };
  const waitAck = async (box) => {
    for (let i = 0; i < 100 && !box.ack; i += 1) {
      await advance(100);
    }
    assert.ok(box.ack, 'answered');
  };
  return { gladys, app, bsb, advance, click, waitAck, lines };
}

const statesOf = (gladys, role) =>
  gladys.fake.states
    .filter((s) => s.device_feature_external_id === feature(role))
    .map((s) => s.state ?? s.text);
const about = (lines, role) => lines.filter(([, line]) => line.includes(role));
const WAITING = /waiting: another command to BSB-LAN is running/;
const REPLACED = /not sent: replaced by a newer value of the same setting/;

// --- 1. Waiting and replaced commands: info, two distinct lines ---------------------

test('n° 9: a command waiting behind another one is logged as info, not as a warning', async (t) => {
  const { advance, click, waitAck, lines } = await setup(t);
  const first = click('hc2-setpoint', 20);
  await settle();
  const second = click('hc2-reduced-target', 15.5);
  await settle();
  // Logged when it starts waiting, whatever comes next.
  const logged = about(lines, 'hc2-reduced-target');
  assert.deepEqual(
    logged.filter(([, l]) => WAITING.test(l)).map(([level]) => level),
    ['info'],
    JSON.stringify(logged),
  );
  await waitAck(second);
  assert.equal(first.ack?.success, true);
  await advance(10 * SECOND);
  const all = about(lines, 'hc2-reduced-target');
  assert.ok(!all.some(([level]) => level === 'warn'), JSON.stringify(all));
});

test('n° 9: a waiting command replaced by a newer value is logged as info, with its own line', async (t) => {
  const { advance, click, lines } = await setup(t);
  click('heating-setpoint', 21);
  await settle();
  const a = click('hc2-setpoint', 19);
  await settle();
  const b = click('hc2-setpoint', 22);
  await advance(15 * SECOND);
  assert.match(a.ack.error, /valeur plus récente de ce réglage/, 'the answer is unchanged');
  assert.ok(b.ack);
  const logged = about(lines, 'hc2-setpoint');
  assert.deepEqual(
    logged.filter(([, l]) => REPLACED.test(l)).map(([level]) => level),
    ['info'],
    JSON.stringify(logged),
  );
  assert.ok(!logged.some(([level]) => level === 'warn'), JSON.stringify(logged));
});

test('n° 9: answered "waiting", then replaced while still waiting: two info lines, no warning', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { advance, click, waitAck, lines } = await setup(t, { bsb });
  // The running write takes 3 s: the next one is answered "waiting" at 4.3 s.
  bsb.behave = (r) =>
    r.endpoint === '/JS' && r.body.Parameter === '710' ? { delay: 2_800 } : undefined;
  click('heating-setpoint', 21);
  await settle();
  const a = click('hc2-setpoint', 19);
  await waitAck(a);
  assert.match(a.ack.error, /attend et part après elle/);
  bsb.behave = undefined;
  const b = click('hc2-setpoint', 22);
  await advance(15 * SECOND);
  assert.ok(b.ack);
  const logged = about(lines, 'hc2-setpoint');
  const info = logged.filter(([level]) => level === 'info').map(([, l]) => l);
  assert.equal(info.filter((l) => WAITING.test(l)).length, 2, JSON.stringify(logged));
  assert.equal(info.filter((l) => REPLACED.test(l)).length, 1, JSON.stringify(logged));
  // The "waiting" answer to Gladys itself: debug only.
  assert.equal(logged.filter(([level]) => level === 'debug').length, 1, JSON.stringify(logged));
  assert.ok(!logged.some(([level]) => level === 'warn'), JSON.stringify(logged));
});

test('n° 9: any other refusal stays a warning', async (t) => {
  const { click, waitAck, lines } = await setup(t);
  const box = click('hc2-reduced-target', 25);
  await waitAck(box);
  assert.match(box.ack.error, /accepte cette consigne entre/);
  const logged = about(lines, 'hc2-reduced-target');
  assert.deepEqual(
    logged.map(([level, l]) => [level, /refused: .*accepte cette consigne/.test(l)]),
    [['warn', true]],
  );
});

// --- 3. Sending to Gladys failed: once per outage --------------------------------------

test('n° 9: sending to Gladys failing every second is logged once, then once when it works again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  const lines = [];
  let down = true;
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      if (down) {
        throw new Error('fetch failed');
      }
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const publisher = new StatePublisher({ gladys, logger: recorder(lines), now: () => Date.now() });
  t.after(() => publisher.stop());
  publisher.start();
  const seconds = async (n) => {
    for (let i = 0; i < n; i += 1) {
      t.mock.timers.tick(SECOND);
      await settle();
    }
  };
  publisher.push('a', { state: 1 });
  await seconds(60);
  // Also through a direct flush (the app's path).
  await publisher.flush().catch(() => {});
  assert.deepEqual(lines, [['warn', lines[0]?.[1]]], JSON.stringify(lines));
  assert.match(lines[0][1], /Sending to Gladys failed: fetch failed/);
  down = false;
  await seconds(2);
  assert.deepEqual(sent, [{ device_feature_external_id: 'a', state: 1 }], 'kept and sent');
  assert.deepEqual(lines.slice(1), [['info', 'Sending to Gladys works again']]);
  publisher.push('b', { state: 2 });
  await seconds(5);
  assert.equal(lines.length, 2, 'nothing more while it works');
  // A second outage is logged again, once.
  down = true;
  publisher.push('c', { state: 3 });
  await seconds(30);
  assert.deepEqual(
    lines.slice(2).map(([level]) => level),
    ['warn'],
  );
  down = false;
  await seconds(2);
  assert.deepEqual(lines.slice(3), [['info', 'Sending to Gladys works again']]);
});

test('r033 m3: a new cause during the same outage is logged once too', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  const lines = [];
  let cause = 'fetch failed';
  const gladys = {
    publishChangedStates: async (batch) => {
      if (cause) {
        throw new Error(cause);
      }
      return { count: batch.length };
    },
  };
  const publisher = new StatePublisher({ gladys, logger: recorder(lines), now: () => Date.now() });
  t.after(() => publisher.stop());
  publisher.start();
  const seconds = async (n) => {
    for (let i = 0; i < n; i += 1) {
      t.mock.timers.tick(SECOND);
      await settle();
    }
  };
  publisher.push('a', { state: 1 });
  await seconds(20);
  cause = 'Request failed with status 422';
  await seconds(20);
  cause = undefined;
  await seconds(3);
  assert.deepEqual(
    lines.map(([level, line]) => [level, line.replace(/ \(retried.*$/, '')]),
    [
      ['warn', 'Sending to Gladys failed: fetch failed'],
      ['warn', 'Sending to Gladys failed: Request failed with status 422'],
      ['info', 'Sending to Gladys works again'],
    ],
  );
});

test('n° 9: Gladys unreachable during an update: the app logs the failure once, then the return', async (t) => {
  const { gladys, app, advance, lines } = await setup(t);
  const publish = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = async () => {
    throw new Error('fetch failed');
  };
  // Polls (app.flush) and the publisher's flush every second, for 2 minutes.
  const poll = app.tick();
  await advance(2 * MINUTE, 500);
  await poll;
  const failed = lines.filter(([, l]) => /Sending to Gladys/.test(l));
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.equal(failed[0][0], 'warn');
  gladys.publishChangedStates = publish;
  await advance(40 * SECOND, 500);
  assert.deepEqual(lines.filter(([, l]) => /Sending to Gladys/.test(l)).slice(1), [
    ['info', 'Sending to Gladys works again'],
  ]);
});

// --- r032-r3 m1: a refusal under the guard gets its own 10 minutes ---------------------

const status0 = (r) =>
  r.endpoint === '/JS'
    ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 0 } }) }
    : undefined;

test('r032-r3 m1 (C1): a value refused under the guard is corrected by a read past the cap of the earlier write', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click, waitAck } = await setup(t, { bsb });
  bsb.behave = status0;
  const a = click('heating-setpoint', 21);
  await waitAck(a);
  assert.match(a.ack.error, /sans confirmation/);
  bsb.behave = undefined;
  assert.equal(bsb.params[710].value, '20.0', 'not applied');
  bsb.down = true;
  await advance(9.5 * MINUTE, 1000);
  assert.equal(app.reshow.size, 1, 'the left mark still holds');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const b = click('heating-setpoint', 22);
  await waitAck(b);
  assert.match(b.ack.error, /non envoyée|injoignable|unreachable/i, b.ack.error);
  // Back past the 10 min of the first write, within the 10 min of the refusal.
  await advance(MINUTE, 1000);
  bsb.down = false;
  await advance(7 * MINUTE, 1000);
  assert.deepEqual(
    statesOf(gladys, 'heating-setpoint').slice(before),
    [20],
    'the card that shows 22 is set back to the real 20 by the first read',
  );
});

// --- r032-r3 m2: the read-only twins are held with their setting -----------------------

test('r032-r3 m2 (S10): the text twin of the mode is never republished with the mode read before the write', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click, waitAck } = await setup(t, { bsb });
  assert.equal(gladys.fake.lastState(feature('operating-mode')), 'Confort');
  // Applied, answered with status 0 ("sent, without confirmation", no read back).
  bsb.behave = (r) => {
    if (r.endpoint === '/JS' && r.body.Parameter === '700') {
      bsb.params[700] = { ...bsb.params[700], value: '2', desc: 'Reduced' };
      return status0(r);
    }
    return undefined;
  };
  const before = statesOf(gladys, 'operating-mode').length;
  const outdoor = statesOf(gladys, 'temperature-outdoor').length;
  const a = click('mode', 'reduced');
  await waitAck(a);
  assert.match(a.ack.error, /sans confirmation \(no status 1\)/);
  bsb.behave = undefined;
  // Gladys forgets what it was sent (an edit of the device, a reconnection),
  // before the follow-up read 5 s after the write.
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  await gladys.fake.deviceUpdated(d);
  await advance(1_500);
  assert.ok(statesOf(gladys, 'temperature-outdoor').length > outdoor, 'the others sent again');
  assert.deepEqual(statesOf(gladys, 'operating-mode').slice(before), [], 'never "Confort" again');
  assert.equal(app.reshow.size, 1);
  // The follow-up read of 700 publishes both.
  await advance(10 * SECOND);
  assert.equal(gladys.fake.lastState(feature('mode')), 'reduced');
  assert.deepEqual(statesOf(gladys, 'operating-mode').slice(before), ['Réduit']);
});

test('r032-r3 m2: offline, the twin still shows that BSB-LAN is unreachable', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click, waitAck } = await setup(t, { bsb });
  bsb.behave = status0;
  const a = click('mode', 'reduced');
  await waitAck(a);
  assert.match(a.ack.error, /sans confirmation/);
  bsb.behave = undefined;
  bsb.down = true;
  await advance(2 * MINUTE, 1000);
  assert.match(String(gladys.fake.lastState(feature('operating-mode'))), /injoignable/);
});

// --- r033 m1: the protective paths stay warnings ----------------------------------------

test('r033 m1: a waiting command dropped by a Protection is a warning, never "replaced"', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { advance, click, waitAck, lines } = await setup(t, { bsb });
  bsb.behave = (r) =>
    r.endpoint === '/JS' && r.body.Parameter === '710' ? { delay: 2_800 } : undefined;
  click('heating-setpoint', 21);
  await settle();
  const waiting = click('hc2-setpoint', 19);
  await advance(200);
  const stop = click('mode', 'protection');
  await waitAck(waiting);
  await waitAck(stop);
  await advance(10 * SECOND);
  assert.match(waiting.ack.error, /protection/i);
  const logged = about(lines, 'hc2-setpoint');
  assert.ok(!logged.some(([, l]) => REPLACED.test(l)), JSON.stringify(logged));
  const ends = logged.filter(([, l]) => /protection/i.test(l));
  assert.deepEqual(
    ends.map(([level]) => level),
    ['warn'],
    JSON.stringify(logged),
  );
});

/** A poll request that holds the adapter 5 s (BSB-LAN serves one client at a time). */
const busyPoll = (r) => (r.endpoint === '/JQ' && r.ids[0] === '700' ? { delay: 5_000 } : undefined);

test('r033 m1: a Protection queued behind a busy adapter answers with a warning', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click, waitAck, lines } = await setup(t, { bsb });
  bsb.behave = busyPoll;
  const poll = app.tick();
  await advance(200);
  const stop = click('dhw-mode-select', 'off');
  await waitAck(stop);
  assert.match(stop.ack.error, /passe en tête/);
  const answered = about(lines, 'dhw-mode-select').filter(([, l]) => /passe en tête/.test(l));
  assert.deepEqual(
    answered.map(([level]) => level),
    ['warn'],
    JSON.stringify(lines),
  );
  bsb.behave = undefined;
  await advance(10 * SECOND);
  await poll;
});

test('r033 m1: the late outcome of a queued Protection that fails is a warning', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click, waitAck, lines } = await setup(t, { bsb });
  bsb.behave = (r) => {
    if (r.endpoint === '/JS') {
      // BSB-LAN refuses it once it is free: status 2.
      return { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 2 } }) };
    }
    return busyPoll(r);
  };
  const poll = app.tick();
  await advance(200);
  const stop = click('dhw-mode-select', 'off');
  await waitAck(stop);
  assert.match(stop.ack.error, /passe en tête/);
  await advance(10 * SECOND);
  await poll;
  const late = lines.filter(([, l]) => /BSB-LAN dhw-mode-select off \(queued\)/.test(l));
  assert.deepEqual(
    late.map(([level]) => level),
    ['warn'],
    JSON.stringify(lines),
  );
});

// --- r033 m2: every twin of TWINS is held with its setting -----------------------------

const TWIN_CASES = [
  ['mode', 'reduced', '700', 'operating-mode'],
  ['hc2-mode', 'reduced', '1000', 'hc2-operating-mode'],
  ['dhw-mode-select', 'eco', '1600', 'dhw-mode'],
  ['heating-reduced-target', 16, '712', 'heating-setpoint-reduced'],
  ['dhw-reduced-target', 35, '1612', 'dhw-setpoint-reduced'],
];

for (const [role, value, id, twin] of TWIN_CASES) {
  test(`r033 m2: the twin ${twin} of ${role} is never republished with the value read before the write`, async (t) => {
    const bsb = fakeBsbLan({ params: fullParams() });
    const { app, gladys, advance, click, waitAck } = await setup(t, { bsb, legacy: true });
    const start = gladys.fake.lastState(feature(twin));
    assert.notEqual(start, undefined, `${twin} published before`);
    // Applied, answered with status 0: "sent, without confirmation", no read back.
    bsb.behave = (r) => {
      if (r.endpoint === '/JS' && r.body.Parameter === id) {
        bsb.params[id] = { ...bsb.params[id], value: String(r.body.Value) };
        return status0(r);
      }
      return undefined;
    };
    const before = statesOf(gladys, twin).length;
    const a = click(role, value);
    await waitAck(a);
    assert.match(a.ack.error, /sans confirmation \(no status 1\)/);
    bsb.behave = undefined;
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    await gladys.fake.deviceUpdated(d);
    await advance(1_500);
    assert.deepEqual(statesOf(gladys, twin).slice(before), [], 'nothing read before the write');
    assert.equal(app.reshow.size, 1);
    // The follow-up read publishes the new value on the twin.
    await advance(10 * SECOND);
    const after = statesOf(gladys, twin).slice(before);
    assert.equal(after.length, 1, JSON.stringify(after));
    assert.notEqual(after[0], start);
  });
}
