// -----------------------------------------------------------------------------
// 0.3.1 (forum t/11458 n° 7): a refused or failed command publishes the real
// value of its feature again at once (the card leaves the value typed); a
// command that arrives while another one runs waits (one per feature, the
// last one wins) instead of being refused, with every check again when it
// leaves; protective commands and restarts drop it. SDK fake Gladys, fake
// BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  MAC_ID,
  NOW,
  fakeBsbLan,
  fullParams,
  inactive,
  settle,
} from './fixtures/fakeBsbLan.js';

const ALLOWED = { address: HOST, allow_commands: true };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;
const quiet = () => {};

async function setup(t, { config = ALLOWED, bsb = fakeBsbLan({ params: fullParams() }) } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new BsbLanApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app);
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
    await gladys.fake.deviceCreated(d);
  }
  await advance(2 * SECOND);
  /** Clicks; the ack lands in the returned box. */
  const click = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    const box = {};
    gladys.fake.setValue(d, target, value).then((a) => (box.ack = a));
    return box;
  };
  return { gladys, app, bsb, advance, click };
}

const statesOf = (gladys, role) =>
  gladys.fake.states
    .filter((s) => s.device_feature_external_id === feature(role))
    .map((s) => s.state ?? s.text);
const writes = (bsb) =>
  bsb.requests.filter((r) => r.endpoint === '/JS').map((r) => [r.body.Parameter, r.body.Value]);
/** Status 1, never applied: the controller ignores the write. */
const ignoring = (r) =>
  r.endpoint === '/JS'
    ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 1 } }) }
    : undefined;

test('a refused command publishes the real value again at once, even unchanged', async (t) => {
  const { gladys, advance, click } = await setup(t);
  const before = statesOf(gladys, 'hc2-reduced-target').length;
  assert.equal(gladys.fake.lastState(feature('hc2-reduced-target')), 18);
  // Above the comfort setpoint of circuit 2 (21): refused by the range of the controller.
  const box = click('hc2-reduced-target', 25);
  await advance(2 * SECOND);
  assert.match(box.ack.error, /accepte cette consigne entre/);
  const after = statesOf(gladys, 'hc2-reduced-target').slice(before);
  assert.deepEqual(after, [18], 'the real value again, without waiting for the 30 min heartbeat');
});

test('a command not applied (read back unchanged): the real value again, and the next reads publish it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = ignoring;
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 22);
  await advance(SECOND);
  assert.match(box.ack.error, /encore la précédente/);
  // At once, without waiting for the 30 min heartbeat.
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20]);
  // The follow-up read (5 s after the write, 1 s long): published again although equal.
  await advance(6 * SECOND);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20, 20]);
});

test('XDECO n° 7: a second setpoint during the first one waits, then leaves; the card follows', async (t) => {
  const sentAt = [];
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = (r) => {
    if (r.endpoint === '/JS') {
      sentAt.push(Date.now());
    }
    return undefined;
  };
  const first = click('hc2-setpoint', 20);
  await settle();
  const second = click('hc2-reduced-target', 15.5);
  await advance(5 * SECOND);
  assert.equal(first.ack.success, true);
  assert.ok(second.ack, 'answered within 5 s');
  assert.match(second.ack.error ?? 'success', /attend et part après elle|success/);
  await advance(10 * SECOND);
  assert.deepEqual(writes(bsb), [
    ['1010', '20.0'],
    ['1012', '15.5'],
  ]);
  assert.ok(sentAt[1] - sentAt[0] >= 3 * SECOND, '3 s between two writes');
  assert.equal(gladys.fake.lastState(feature('hc2-reduced-target')), 15.5);
});

test('one waiting command per feature: the last one wins', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await settle();
  const a = click('hc2-setpoint', 19);
  await settle();
  const b = click('hc2-setpoint', 22);
  await advance(15 * SECOND);
  assert.match(a.ack.error, /valeur plus récente de ce réglage/);
  assert.ok(b.ack);
  assert.deepEqual(writes(bsb), [
    ['710', '21.0'],
    ['1010', '22.0'],
  ]);
});

test('a waiting command is dropped by a protective command that arrives after it; the stop is not delayed', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  const running = click('heating-setpoint', 21);
  await settle();
  const waiting = click('hc2-setpoint', 24);
  await settle();
  const before = statesOf(gladys, 'hc2-setpoint').length;
  const stop = click('hc2-mode', 'protection');
  await settle();
  assert.equal(app.waiting.size, 0, 'dropped at once, never left waiting');
  await advance(15 * SECOND);
  assert.match(waiting.ack.error, /commande de protection .* est arrivée après/);
  // The one running, not sent yet, is cancelled too (as before 0.3.1).
  assert.match(running.ack.error, /est arrivée après/);
  assert.equal(stop.ack.success, true);
  assert.deepEqual(writes(bsb), [['1000', '0']], 'the stop alone, first');
  assert.equal(app.waiting.size, 0);
  // Its card shows the real value again.
  assert.ok(statesOf(gladys, 'hc2-setpoint').slice(before).includes(21));
});

test('a waiting command is dropped by a restart (new configuration); never sent after it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await settle();
  const waiting = click('hc2-setpoint', 24);
  await settle();
  void app.start(ALLOWED);
  await advance(15 * SECOND);
  assert.match(waiting.ack.error, /redémarré pendant l'attente|n'est pas l'adaptateur/);
  assert.ok(!writes(bsb).some(([id]) => id === '1010'));
});

test('a waiting command checks everything again when it leaves: the option turned off, not sent', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await settle();
  const waiting = click('hc2-setpoint', 24);
  await settle();
  await app.configUpdated({ address: HOST, allow_commands: false });
  await advance(15 * SECOND);
  assert.match(waiting.ack.error, /commandes sont désactivées/);
  assert.ok(!writes(bsb).some(([id]) => id === '1010'));
});

test('a waiting hot water setpoint checks the ceiling again when it leaves', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await settle();
  const waiting = click('dhw-setpoint', 60);
  await settle();
  await app.configUpdated({ ...ALLOWED, dhw_max_temperature: 55 });
  await advance(15 * SECOND);
  assert.match(waiting.ack.error, /plafonnée à 55 °C/);
  assert.ok(!writes(bsb).some(([id]) => id === '1610'));
});

// --- Review 0.3.1 r1 (I1, m1, m2, m3) -------------------------------------------------

/** The write is applied, its answer never comes in time ("sent, without confirmation"). */
const appliedLate = (r) => (r.endpoint === '/JS' ? 'silent-applied' : undefined);

test('r031 I1: a write that may have left (applied, answer late) never sets the card back to the old value', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedLate;
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 22);
  await advance(5 * SECOND);
  assert.match(box.ack.error, /sans confirmation/);
  assert.equal(bsb.params[710].value, '22.0', 'applied by the controller');
  bsb.behave = undefined;
  await advance(25 * SECOND);
  const after = statesOf(gladys, 'heating-setpoint').slice(before);
  assert.ok(!after.includes(20), `never the value read before the write: ${after}`);
  assert.equal(after.at(-1), 22, 'the reads that follow settle it');
});

test('r031 I1: a Protection sent without confirmation never sets the card back to the old mode', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedLate;
  const before = statesOf(gladys, 'mode').length;
  const box = click('mode', 'protection');
  await advance(5 * SECOND);
  assert.match(box.ack.error, /sans confirmation|passe en tête/);
  bsb.behave = undefined;
  await advance(25 * SECOND);
  const after = statesOf(gladys, 'mode').slice(before);
  assert.ok(!after.includes('comfort'), `never the mode read before: ${after}`);
  assert.equal(gladys.fake.lastState(feature('mode')), 'protection');
});

test('r031 m1: a confirmed success is published once, not again by the reads that follow', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 22);
  await advance(30 * SECOND);
  assert.equal(box.ack.success, true);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [22]);
});

test('r031 m2: a queued command that cannot start within 30 s is dropped, the card shows the real value', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await advance(2 * SECOND);
  // The adapter kept busy (a long run of commands): nothing may start for 40 s.
  app.quietUntil = Date.now() + 40 * SECOND;
  const before = statesOf(gladys, 'hc2-setpoint').length;
  const late = click('hc2-setpoint', 24);
  await advance(45 * SECOND);
  assert.match(late.ack.error, /attend et part après elle/);
  assert.ok(!writes(bsb).some(([id]) => id === '1010'), 'never sent');
  assert.ok(statesOf(gladys, 'hc2-setpoint').slice(before).includes(21), 'the real value again');
});

test('r031 m3: restart while a command waits, the new adapter read within the 3 s: never sent', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 21);
  await advance(1500);
  assert.deepEqual(writes(bsb), [['710', '21.0']]);
  const waiting = click('hc2-setpoint', 24);
  await settle();
  assert.equal(app.waiting.size, 1);
  // A new configuration: started again, the adapter read again, live before the 3 s are over.
  const restarting = app.start(ALLOWED);
  await advance(1500);
  await restarting;
  assert.ok(app.live, 'read again within the 3 s');
  await advance(10 * SECOND);
  assert.match(waiting.ack.error, /redémarré pendant l'attente/);
  assert.deepEqual(writes(bsb), [['710', '21.0']], 'never sent on the new configuration');
});

test('r031 m3: a command still waiting at its answer never sets its card back; it lands afterwards', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedLate; // the first one holds the adapter until 4.3 s
  click('heating-setpoint', 21);
  await settle();
  bsb.behave = (r) =>
    r.endpoint === '/JS' && r.body.Parameter === '710' ? 'silent-applied' : undefined;
  const before = statesOf(gladys, 'hc2-setpoint').length;
  const waiting = click('hc2-setpoint', 23);
  await advance(4_500);
  assert.match(waiting.ack.error, /attend et part après elle/);
  assert.deepEqual(statesOf(gladys, 'hc2-setpoint').slice(before), [], 'nothing while it waits');
  await advance(10 * SECOND);
  assert.ok(writes(bsb).some(([id, v]) => id === '1010' && v === '23.0'));
  assert.equal(gladys.fake.lastState(feature('hc2-setpoint')), 23);
});

// --- Review 0.3.1 r2 (n1, n2), 0.3.2 ----------------------------------------------------

/** /JS answered status 0: "sent, without confirmation", never applied. */
const status0 = (r) =>
  r.endpoint === '/JS'
    ? { status: 200, body: JSON.stringify({ [r.body.Parameter]: { status: 0 } }) }
    : undefined;

test('r031-r2 n1 (Q11): unconfirmed, not applied, every read back failed: the first good read shows the real value', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = status0;
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 21);
  await advance(SECOND);
  assert.match(box.ack.error, /sans confirmation \(no status 1\)/);
  assert.equal(bsb.params[710].value, '20.0', 'never applied');
  bsb.behave = undefined;
  // The 5 s and 20 s read backs fail, and the polls after them, for 40 s.
  bsb.down = true;
  await advance(40 * SECOND);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'nothing while down');
  bsb.down = false;
  const reads = bsb.reads().length;
  await advance(4 * 60 * SECOND, 500);
  assert.ok(bsb.reads().length > reads, 'read again');
  assert.deepEqual(
    statesOf(gladys, 'heating-setpoint').slice(before),
    [20],
    'the real value, once, although equal to the last published',
  );
});

test('r031-r2 n1: the mark is lifted by the first good read after the window, then nothing more', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = status0;
  click('heating-setpoint', 21);
  await advance(SECOND);
  bsb.behave = undefined;
  bsb.down = true;
  await advance(40 * SECOND);
  bsb.down = false;
  await advance(4 * 60 * SECOND, 500);
  assert.equal(app.reshow.size, 0, 'the mark is gone');
  const before = statesOf(gladys, 'heating-setpoint').length;
  await advance(2 * 60 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'equal: not again');
});

test('r031-r2 n1: the mark ends at its cap (10 min) when no read ever succeeds', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, advance, click } = await setup(t, { bsb });
  bsb.behave = status0;
  click('heating-setpoint', 21);
  await advance(SECOND);
  bsb.behave = undefined;
  bsb.down = true;
  await advance(5 * 60 * SECOND, 1000);
  assert.equal(app.reshow.size, 1, 'kept past the 25 s while no read succeeds');
  // Polls go on every 5 min at most: one after the cap drops it.
  await advance(11 * 60 * SECOND, 1000);
  assert.equal(app.reshow.size, 0, 'dropped at the cap');
});

/** Each "sent, without confirmation" path: the card is never set back at once. */
const unconfirmedPaths = [
  ['no status 1', () => status0],
  [
    'not read back: timeout',
    () => {
      let written = false;
      return (r) => {
        if (r.endpoint === '/JS') {
          written = true;
          return { status: 200, body: JSON.stringify({ 710: { status: 1 } }) };
        }
        return written && r.endpoint === '/JQ' ? 'timeout' : undefined;
      };
    },
  ],
  [
    'not read back',
    () => {
      let written = false;
      return (r) => {
        if (r.endpoint === '/JS') {
          written = true;
          return { status: 200, body: JSON.stringify({ 710: { status: 1 } }) };
        }
        return written && r.endpoint === '/JQ'
          ? { raw: { 710: inactive('Comfort setpoint') } }
          : undefined;
      };
    },
  ],
  [
    'not read back in time',
    () => (r) =>
      r.endpoint === '/JS'
        ? { status: 200, delay: 3_900, body: JSON.stringify({ 710: { status: 1 } }) }
        : undefined,
  ],
];

for (const [reason, behave] of unconfirmedPaths) {
  test(`r031-r2 n2: "${reason}" never republishes the value read before; the next read does`, async (t) => {
    const bsb = fakeBsbLan({ params: fullParams() });
    const { gladys, advance, click } = await setup(t, { bsb });
    bsb.behave = behave();
    const before = statesOf(gladys, 'heating-setpoint').length;
    const box = click('heating-setpoint', 21);
    await advance(4_500);
    assert.ok(box.ack, 'answered');
    assert.ok(
      box.ack.error?.includes(`sans confirmation (${reason})`),
      `the path under test: ${box.ack.error}`,
    );
    bsb.behave = undefined;
    assert.deepEqual(
      statesOf(gladys, 'heating-setpoint').slice(before),
      [],
      'nothing from before the write',
    );
    // The follow-up read (5 s after the write) publishes what it reads, even equal.
    await advance(6 * SECOND);
    assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20]);
  });
}

test('r031-r2 n2: a queued command replaced by a newer one never sets the card back', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  click('heating-setpoint', 22);
  await settle();
  const before = statesOf(gladys, 'hc2-setpoint').length;
  const a = click('hc2-setpoint', 19);
  await settle();
  const b = click('hc2-setpoint', 23);
  await settle();
  await advance(200);
  assert.match(a.ack.error, /valeur plus récente de ce réglage/);
  assert.deepEqual(
    statesOf(gladys, 'hc2-setpoint').slice(before),
    [],
    'nothing while the newer waits',
  );
  await advance(15 * SECOND);
  assert.ok(b.ack);
  assert.equal(gladys.fake.lastState(feature('hc2-setpoint')), 23);
  assert.ok(!statesOf(gladys, 'hc2-setpoint').slice(before).includes(21));
});

// --- Review 0.3.2 r1 (I1, m1) ----------------------------------------------------------

/** The write is applied at once, its answer never comes: "sent, without confirmation (timeout)". */
const appliedNoAnswer = (bsb, id) => (r) => {
  if (r.endpoint === '/JS' && r.body.Parameter === id) {
    bsb.params[id] = { ...bsb.params[id], value: r.body.Value };
    return 'timeout';
  }
  return undefined;
};

test('r032 I1 (Q13): a command in the middle of a poll, applied, unanswered: never the value read before', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  // Slow reads (0.7 s each): a periodic poll lasts several seconds, the
  // command passes between two of its batches.
  let pollStarted = false;
  const write = appliedNoAnswer(bsb, '710');
  bsb.behave = (r) => {
    if (r.endpoint === '/JQ') {
      if (r.ids[0] === '700' && r.ids.includes('710')) {
        pollStarted = true;
      }
      return { delay: 700 };
    }
    return write(r);
  };
  for (let i = 0; i < 600 && !pollStarted; i += 1) {
    await advance(100);
  }
  assert.ok(pollStarted, 'a periodic poll started');
  // Its first batch (710 = 20) is read, the second one is in flight.
  await advance(1000);
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 21);
  await advance(4_500);
  assert.match(box.ack.error, /sans confirmation \(timeout\)/);
  assert.equal(bsb.params[710].value, '21.0', 'applied');
  // The poll ends with the values read before the write (its batch 1 and
  // the fresh read of the command): 20 is not forced to the card.
  await advance(4 * SECOND);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'never 20 while at 21');
  bsb.behave = undefined;
  await advance(30 * SECOND, 500);
  assert.deepEqual(
    statesOf(gladys, 'heating-setpoint').slice(before),
    [21],
    '21 at the first read of 710 after the write',
  );
});

test('r032 I1: a poll that takes the read back of the command (made after the write) forces it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  let pollStarted = false;
  let pollEnded = false;
  bsb.behave = (r) => {
    if (r.endpoint === '/JQ') {
      if (r.ids[0] === '700' && r.ids.includes('710')) {
        pollStarted = true;
      }
      if (pollStarted && r.ids.includes('8770')) {
        pollEnded = true;
      }
      return { delay: 700 };
    }
    if (r.endpoint === '/JS' && r.body.Parameter === '710') {
      // Status 1, the controller keeps 21.5: "not read back".
      bsb.params[710] = { ...bsb.params[710], value: '21.5' };
      return { status: 200, body: JSON.stringify({ 710: { status: 1 } }) };
    }
    return undefined;
  };
  for (let i = 0; i < 600 && !pollStarted; i += 1) {
    await advance(100);
  }
  await advance(1000);
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 21);
  await advance(3_500);
  assert.match(box.ack.error, /sans confirmation \(not read back\)/);
  assert.equal(app.reshow.size, 1);
  for (let i = 0; i < 200 && !pollEnded; i += 1) {
    await advance(100);
  }
  await advance(1000);
  // The poll replaced its batch 1 (before the write) by the read back:
  // with its number, after the write: forced, the mark lifted.
  assert.ok(
    [...app.reshow.values()].every((m) => m.read),
    'lifted by the poll that took the read back',
  );
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21.5, 21.5]);
});

test('r032 I1 (Q14): another command in the window never forces the value read before the write', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedNoAnswer(bsb, '710');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  await advance(200);
  const b = click('dhw-setpoint', 55);
  for (let i = 0; i < 150 && !writes(bsb).some(([id]) => id === '1610'); i += 1) {
    await advance(100);
  }
  await advance(400);
  assert.match(a.ack.error, /sans confirmation \(timeout\)/);
  assert.ok(b.ack, 'the second one answered');
  assert.equal(bsb.params[1610].value, '55', 'the second one written');
  assert.equal(bsb.params[710].value, '21.0', 'the first one applied');
  // Its fresh read and its read back published everything in memory: 710
  // there is still the value read before the first write.
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'never 20');
  // Every read fails for 40 s: the card is left alone.
  bsb.behave = undefined;
  bsb.down = true;
  await advance(40 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'nothing while down');
  assert.equal(app.reshow.size, 1, 'the mark waits for a read of 710');
  bsb.down = false;
  await advance(4 * 60 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21], '21 at the reprise');
  assert.equal(app.reshow.size, 0);
});

test('r032 I1: Gladys forgetting what it was sent (DEVICE_UPDATED) never brings back the value read before the write', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedNoAnswer(bsb, '710');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 21);
  await advance(4_500);
  assert.match(box.ack.error, /sans confirmation \(timeout\)/);
  bsb.behave = undefined;
  bsb.down = true;
  // The user edits the device in Gladys: the SDK forgets what it sent, the
  // states of the device are pushed again.
  const d = gladys.fake.devices.find((x) => x.external_id === device);
  await gladys.fake.deviceUpdated(d);
  await advance(40 * SECOND, 500);
  assert.ok(
    statesOf(gladys, 'heating-reduced-target').length > 0,
    'the other features were sent again',
  );
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'never 20');
  assert.equal(app.reshow.size, 1);
  bsb.down = false;
  await advance(4 * 60 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21]);
});

test('r032 I1: another command whose fresh read takes the parameter again forces its real value', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = status0; // never applied
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  await advance(100);
  click('heating-reduced-target', 16);
  await advance(900);
  assert.match(a.ack.error, /sans confirmation \(no status 1\)/);
  bsb.behave = undefined;
  // The second one leaves 3 s after the first write; its fresh read (710,
  // 712, 714, 716) is made after that write: 20, forced, before the 5 s read.
  await advance(3_000);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20]);
  await advance(30 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20], 'once');
});

test('r032 I1: the read back of an unconfirmed write is a read after it: the mark is lifted by it', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  // Status 1, but the controller keeps 21.5 (read back neither 21 nor 20).
  bsb.behave = (r) => {
    if (r.endpoint === '/JS' && r.body.Parameter === '710') {
      bsb.params[710] = { ...bsb.params[710], value: '21.5' };
      return { status: 200, body: JSON.stringify({ 710: { status: 1 } }) };
    }
    return undefined;
  };
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  await advance(100);
  click('dhw-setpoint', 55);
  await advance(900);
  assert.match(a.ack.error, /sans confirmation \(not read back\)/);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21.5], 'the read back');
  bsb.behave = undefined;
  // The next publication (the second command, 3 s later) forces the value
  // read back once (Gladys may still show the value typed), and ends the mark.
  await advance(3_000);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21.5, 21.5]);
  assert.equal(app.reshow.size, 0, 'lifted before the 5 s read');
  await advance(30 * SECOND, 500);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21.5, 21.5]);
});

test('r032 m1: no window of republications: the refusal, the next read of the parameter, then nothing equal', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = ignoring;
  const before = statesOf(gladys, 'heating-setpoint').length;
  const box = click('heating-setpoint', 22);
  await advance(SECOND);
  assert.match(box.ack.error, /encore la précédente/);
  bsb.behave = undefined;
  // At once, then the 5 s read (the card may have kept the value typed
  // after the first one); the 20 s read and the next poll: equal, skipped.
  await advance(60 * SECOND);
  assert.ok(bsb.reads().length >= 4, 'read several times');
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20, 20]);
  assert.equal(app.reshow.size, 0);
});

// r032 r2 I1: an earlier write of the same setting left without confirmation
// (and was applied); a second command of that setting is refused before its
// own fresh read: the value in memory dates from before the first write and
// is never forced; the first read of the parameter after that write is.
const appliedThen = (bsb, id, override) => (r) => {
  if (r.endpoint === '/JS' && r.body.Parameter === id) {
    bsb.params[id] = { ...bsb.params[id], value: r.body.Value };
    return override;
  }
  return undefined;
};

test('r032 r2 I1 (R1): applied, answered 500 (pause), the same setting again refused "paused": never the value read before', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedThen(bsb, '710', { status: 500 });
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  await advance(4_500);
  assert.match(a.ack.error, /sans confirmation/);
  assert.equal(bsb.params[710].value, '21.0', 'applied');
  const b = click('heating-setpoint', 21);
  await advance(4_500);
  assert.match(b.ack.error, /en pause/);
  bsb.behave = undefined;
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'never 20');
  assert.equal(app.reshow.size, 1);
  assert.ok([...app.reshow.values()][0].left, 'the left mark is kept');
  await advance(4 * 60 * SECOND, 500);
  assert.deepEqual(
    statesOf(gladys, 'heating-setpoint').slice(before),
    [21],
    '21 at the first read of 710 after the pause',
  );
  assert.equal(app.reshow.size, 0);
});

test('r032 r2 I1 (R2): applied, unanswered, the same setting queued then dropped by a Protection: never the value read before', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedThen(bsb, '710', { delay: 6_000 });
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  for (let i = 0; i < 60 && !a.ack; i += 1) {
    await advance(100);
  }
  assert.match(a.ack.error, /sans confirmation/);
  const b = click('heating-setpoint', 22);
  await advance(300);
  const c = click('mode', 'protection');
  await advance(2_000);
  assert.match(b.ack.error, /protection/i);
  assert.ok(c.ack, 'the Protection answered');
  assert.equal(bsb.params[710].value, '21.0', 'the first one applied');
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'never 20');
  bsb.behave = undefined;
  await advance(60 * SECOND, 500);
  const after = statesOf(gladys, 'heating-setpoint').slice(before);
  assert.ok(!after.includes(20), `never 20: ${after}`);
  assert.equal(after.at(-1), 21, '21 at the first read of 710');
});

test('r032 r2 I1 (R3, slow adapter): applied, unanswered, the same setting refused before its fresh read: never the value read before', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedNoAnswer(bsb, '710');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  for (let i = 0; i < 60 && !a.ack; i += 1) {
    await advance(100);
  }
  assert.match(a.ack.error, /sans confirmation/);
  assert.equal(bsb.params[710].value, '21.0', 'applied');
  // Let the write and its follow-up end, then slow reads (3 s each): a poll
  // holds the adapter, the second command cannot read 710 in time.
  await advance(3 * SECOND);
  bsb.behave = (r) => (r.endpoint === '/JQ' ? { delay: 3_000 } : undefined);
  const poll = app.tick();
  await advance(200);
  const b = click('heating-setpoint', 22);
  for (let i = 0; i < 100 && !b.ack; i += 1) {
    await advance(100);
  }
  assert.match(b.ack.error, /non envoyée/);
  assert.notEqual(bsb.params[710].value, '22', 'never sent');
  const atRefusal = statesOf(gladys, 'heating-setpoint').slice(before);
  assert.ok(!atRefusal.includes(20), `never 20 at the refusal: ${atRefusal}`);
  bsb.behave = undefined;
  await advance(10 * SECOND);
  await poll;
  await advance(60 * SECOND, 500);
  const after = statesOf(gladys, 'heating-setpoint').slice(before);
  assert.ok(!after.includes(20), `never 20: ${after}`);
  assert.equal(after.at(-1), 21, '21 at the first read of 710');
});

test('r032 r2 I1: the mark guard of showReal ends at the cap (the value in memory is forced again)', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedNoAnswer(bsb, '710');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  for (let i = 0; i < 60 && !a.ack; i += 1) {
    await advance(100);
  }
  assert.match(a.ack.error, /sans confirmation/);
  const target = { mac: app.adapter.mac, role: 'heating-setpoint' };
  assert.equal(app.reshow.size, 1);
  app.showReal(target);
  await advance(100);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [], 'kept within the cap');
  // The cap reached (no read of 710 for 10 min): the guard ends.
  const [mark] = app.reshow.values();
  mark.cap = Date.now();
  app.showReal(target);
  await advance(100);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20], 'forced at the cap');
  assert.equal([...app.reshow.values()][0].left, false, 'a new mark, not left');
});

test('r032 r2 m2: the mark of the reduced setpoint (712) is lifted by the read back of 712', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { app, gladys, advance, click } = await setup(t, { bsb });
  // Status 1, but the controller keeps 16.5 (read back neither 16 nor before).
  bsb.behave = (r) => {
    if (r.endpoint === '/JS' && r.body.Parameter === '712') {
      bsb.params[712] = { ...bsb.params[712], value: '16.5' };
      return { status: 200, body: JSON.stringify({ 712: { status: 1 } }) };
    }
    return undefined;
  };
  const before = statesOf(gladys, 'heating-reduced-target').length;
  const a = click('heating-reduced-target', 16);
  await advance(100);
  click('dhw-setpoint', 55);
  await advance(900);
  assert.match(a.ack.error, /sans confirmation \(not read back\)/);
  bsb.behave = undefined;
  // The second command (3 s later) reads 1610.. only: 710 is not read again.
  await advance(3_000);
  assert.equal(app.reshow.size, 0, 'lifted by the read back of 712, before the 5 s read');
  assert.deepEqual(statesOf(gladys, 'heating-reduced-target').slice(before), [16.5, 16.5]);
});

test('r032 r2 I1: the guard keeps only a left mark: two surely refused commands both show the real value', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = (r) => {
    if (r.endpoint === '/JS' && r.body.Parameter === '1610') {
      return { delay: 2_000 };
    }
    return ignoring(r);
  };
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 22);
  await advance(SECOND);
  assert.match(a.ack.error, /encore la précédente/);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20]);
  // Before any read of 710: another one waits behind a slow write, then a
  // Protection drops it. Surely not applied: the real value again, at once.
  click('dhw-setpoint', 55);
  await advance(200);
  const b = click('heating-setpoint', 23);
  await advance(300);
  click('mode', 'protection');
  await advance(500);
  assert.match(b.ack.error, /protection/i);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [20, 20]);
});

test('r032 r2 I1: once its parameter is read after the write, a refusal of the same setting shows the real value again', async (t) => {
  const bsb = fakeBsbLan({ params: fullParams() });
  const { gladys, advance, click } = await setup(t, { bsb });
  bsb.behave = appliedNoAnswer(bsb, '710');
  const before = statesOf(gladys, 'heating-setpoint').length;
  const a = click('heating-setpoint', 21);
  for (let i = 0; i < 60 && !a.ack; i += 1) {
    await advance(100);
  }
  assert.match(a.ack.error, /sans confirmation/);
  bsb.behave = undefined;
  // Above the comfort maximum: refused after its fresh read (710 = 21, read
  // after the write): published by that read, then forced again by the refusal.
  const b = click('heating-setpoint', 35);
  for (let i = 0; i < 300 && !b.ack; i += 1) {
    await advance(100);
  }
  assert.match(b.ack.error, /entre/);
  assert.deepEqual(statesOf(gladys, 'heating-setpoint').slice(before), [21, 21]);
});
