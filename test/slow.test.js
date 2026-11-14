// -----------------------------------------------------------------------------
// 0.3.4 (forum t/11458 n° 11, XDECO: BSB-LAN 5.1.42 on an ESP32 in Wi-Fi, two
// circuits, no other client): at rest 0.25 s per parameter read; after a
// write, 1 to 2 s per parameter for about 10 s. The command budgets count
// from the moment a command gets the adapter (12 s for its /JI and fresh
// read, at least 4 s for its answer and read back); Gladys gets "going on"
// by 4.5 s. After a failed poll (a timeout), a command tries the identified
// adapter itself instead of being refused for the whole backoff. SDK fake
// Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

async function setup(t, { config = {}, bsb = fakeBsbLan({ params: fullParams() }) } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({
    config: { address: HOST, allow_commands: true, ...config },
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push({ level, line: args.map(String).join(' ') }),
    ]),
  );
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
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
    await gladys.fake.deviceCreated(d);
  }
  await advance(2 * SECOND);
  const click = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    const box = { at: Date.now() };
    gladys.fake.setValue(d, target, value).then((a) => {
      box.ack = a;
      box.took = Date.now() - box.at;
    });
    return box;
  };
  /** Advances until `done()` or `max` ms. */
  const until = async (done, max = 60 * SECOND) => {
    for (let i = 0; i < max / 100 && !done(); i += 1) {
      await advance(100);
    }
  };
  return { gladys, app, bsb, advance, click, until, logs };
}

/**
 * XDECO's timings: 0.25 s per parameter at rest (the /JI 0.25 s), 1.5 s per
 * parameter (the /JI 1 s) for 10 s after the answer of each write.
 */
function xdeco(bsb) {
  let slowUntil = -Infinity;
  bsb.behave = (r) => {
    const slow = Date.now() < slowUntil;
    if (r.endpoint === '/JS') {
      wroteAt = Date.now();
      // The write is answered after 1 s; the slow window counts from then.
      slowUntil = Date.now() + 1_000 + 10 * SECOND;
      return { delay: 1_000 };
    }
    if (r.endpoint === '/JI') {
      return { delay: slow ? 1_000 : 250 };
    }
    if (r.endpoint === '/JQ') {
      return { delay: r.ids.length * (slow ? 1_500 : 250) };
    }
    return undefined;
  };
}

let wroteAt;
const writes = (bsb) =>
  bsb.requests.filter((r) => r.endpoint === '/JS').map((r) => [r.body.Parameter, r.body.Value]);

test('XDECO n° 11: a circuit 2 setpoint queued right after a write is sent and confirmed', async (t) => {
  const s = await setup(t);
  xdeco(s.bsb);
  const a = s.click('heating-setpoint', 21);
  await s.until(() => a.ack);
  assert.equal(a.ack.error, undefined, 'the first one passes at rest');
  // 1 s later: queued behind the 3 s spacing, then read in the slow window
  // (its /JI 1 s, 5 parameters 7.5 s: far above the 2.5 s of 0.3.3).
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  assert.ok(b.took <= 4_300, `answered by 4.3 s: ${b.took}`);
  assert.match(b.ack.error, /autre commande vers BSB-LAN est en cours/);
  await s.until(() => s.bsb.params[1010].value === '22.0' && !s.app.inFlight, 40 * SECOND);
  assert.equal(s.bsb.params[1010].value, '22.0', 'written');
  assert.deepEqual(writes(s.bsb), [
    ['710', '21.0'],
    ['1010', '22.0'],
  ]);
  assert.ok(
    s.logs.some((l) => l.level === 'info' && /hc2-setpoint 22 \(queued\): done/.test(l.line)),
    'its success is logged',
  );
  assert.ok(!s.logs.some((l) => l.level === 'warn' && /hc2-setpoint/.test(l.line)), 'no warning');
});

test('XDECO n° 11: a click 9.9 s after a write, a follow-up poll in flight: "going on", then sent and read back', async (t) => {
  const s = await setup(t);
  xdeco(s.bsb);
  const a = s.click('heating-setpoint', 21);
  await s.until(() => a.ack);
  assert.equal(a.ack.error, undefined);
  // The write left about 0.6 s after the click and was answered 1 s later;
  // the follow-up read (5 s after it) is in flight at the second click.
  await s.advance(Math.max(0, wroteAt + 9_900 - Date.now()));
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  assert.ok(b.took <= 4_500, `answered by 4.5 s: ${b.took}`);
  assert.match(b.ack.error, /répond lentement.*la commande continue/);
  assert.ok(
    s.logs.some((l) => l.level === 'info' && /répond lentement|answers slowly/.test(l.line)),
    '"going on" is logged as info',
  );
  await s.until(() => !s.app.inFlight, 40 * SECOND);
  assert.equal(s.bsb.params[1010].value, '22.0', 'written');
  assert.ok(
    s.logs.some((l) => l.level === 'info' && /hc2-setpoint 22 \(going on\): done/.test(l.line)),
    'success after its read back',
  );
  assert.ok(!s.logs.some((l) => l.level === 'warn' && /hc2-setpoint/.test(l.line)), 'no warning');
});

test('a command never leaves past its budgets: the fresh read over 12 s from getting the adapter: not sent', async (t) => {
  const s = await setup(t);
  s.bsb.behave = (r) => (r.endpoint === '/JQ' ? { delay: r.ids.length * 2_500 } : undefined);
  // 5 parameters at 2.5 s: 12.5 s.
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => !s.app.inFlight && b.ack, 40 * SECOND);
  assert.match(b.ack.error, /la commande continue/);
  assert.deepEqual(writes(s.bsb), []);
  assert.ok(
    s.logs.some(
      (l) =>
        l.level === 'warn' && /hc2-setpoint 22 \(going on\).*(timeout).*non envoyée/.test(l.line),
    ),
    s.logs.map((l) => l.line).join(' | '),
  );
});

/** A poll whose /JQ times out (16 s, above the 15 s of a poll request): unreachable, backoff. */
async function failedPoll(s) {
  let fail = true;
  s.bsb.behave = (r) => (fail && r.endpoint === '/JQ' ? { delay: 16 * SECOND } : undefined);
  const poll = s.app.tick();
  await s.advance(16 * SECOND);
  await poll;
  fail = false;
  s.bsb.behave = undefined;
  assert.equal(s.app.adapter.online, false);
  assert.equal(s.app.adapter.wait, 10 * MINUTE, 'next poll in 600 s (the interval)');
  assert.ok(
    s.logs.some((l) => /timeout; next try in 600 s/.test(l.line)),
    s.logs.map((l) => l.line).join(' | '),
  );
}

test('XDECO n° 11: after a poll timeout, interval 10 min: a command tries the adapter itself and passes', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  await s.advance(MINUTE);
  const before = s.bsb.requests.length;
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  assert.equal(b.ack.error, undefined, 'sent and read back');
  assert.equal(s.bsb.params[1010].value, '22.0');
  assert.deepEqual(
    s.bsb.requests.slice(before).map((r) => r.endpoint),
    ['/JI', '/JQ', '/JS', '/JQ'],
    'its own /JI first, its fresh read, the write, the read back: no poll',
  );
  // Still read on its own schedule only: nothing until the 600 s are over.
  await s.advance(5 * MINUTE);
  assert.equal(s.bsb.requests.length, before + 4, 'no follow-up read while offline');
  assert.equal(s.app.adapter.online, false);
});

test('during the backoff, another adapter at the address: never written to it', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  s.bsb.info = { ...s.bsb.info, MAC: '00:80:41:aa:bb:cc' };
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  assert.match(b.ack.error, /pas l'adaptateur lu actuellement.*non envoyée/);
  assert.equal(s.bsb.requests.at(-1).endpoint, '/JI', 'nothing after its /JI');
  assert.deepEqual(writes(s.bsb), []);
});

test('during the backoff, a passing failure of the command itself: not sent, the backoff unchanged', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  s.bsb.down = true;
  const wait = s.app.adapter.timer;
  const b = s.click('mode', 'reduced');
  await s.until(() => b.ack);
  assert.match(b.ack.error, /relue juste avant \(unreachable\).*non envoyée/);
  assert.deepEqual(writes(s.bsb), []);
  assert.equal(s.app.adapter.timer, wait, 'the next poll keeps its time');
});

test('no command of its own after a read that gave no MAC, nor during a pause', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  const { MAC, ...noMac } = s.bsb.info;
  assert.ok(MAC);
  s.bsb.info = noMac;
  s.app.tick();
  await s.advance(SECOND);
  assert.equal(s.app.adapter.error, 'noMac');
  const before = s.bsb.requests.length;
  const a = s.click('mode', 'reduced');
  await s.until(() => a.ack);
  assert.match(a.ack.error, /pas l'adaptateur lu actuellement/);
  assert.equal(s.bsb.requests.length, before, 'nothing requested');
  // A 503: paused.
  s.bsb.info = { ...noMac, MAC };
  s.bsb.behave = (r) => (r.endpoint === '/JI' ? { status: 503 } : undefined);
  await s.advance(31 * MINUTE);
  assert.equal(s.app.adapter.error, 'busy');
  s.bsb.behave = undefined;
  const count = s.bsb.requests.length;
  const b = s.click('mode', 'reduced');
  await s.until(() => b.ack);
  assert.match(b.ack.error, /en pause/);
  assert.equal(s.bsb.requests.length, count);
  assert.deepEqual(writes(s.bsb), []);
});

test('a Protection during the slow fresh read of a command: the command stops after its /JI, the Protection is written next', async (t) => {
  const s = await setup(t);
  let slow = true;
  s.bsb.behave = (r) => {
    if (slow && r.endpoint === '/JI') {
      return { delay: 3_000 };
    }
    if (r.endpoint === '/JQ' && r.ids.length > 1) {
      // The fresh read of the command: 8 s.
      return { delay: 8_000 };
    }
    return undefined;
  };
  const a = s.click('heating-setpoint', 22);
  await s.advance(1_000);
  slow = false;
  const p = s.click('mode', 'protection');
  await s.until(() => s.bsb.params[700].value === '0', 10 * SECOND);
  assert.equal(s.bsb.params[700].value, '0', 'written');
  assert.ok(Date.now() - p.at < 2_500, 'right after the /JI of the command, not after its read');
  await s.until(() => a.ack && p.ack && !s.app.inFlight);
  assert.match(a.ack.error, /commande de protection.*arrivée après/);
  assert.deepEqual(writes(s.bsb), [['700', '0']]);
});

test('a write that leaves late gets 4 s for its answer and read back', async (t) => {
  const s = await setup(t);
  // The fresh read 6 s, then the write and the read back 1.5 s each.
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JQ') {
      return { delay: r.ids.length > 1 ? 6_000 : 1_500 };
    }
    return r.endpoint === '/JS' ? { delay: 1_500 } : undefined;
  };
  const b = s.click('heating-setpoint', 22);
  await s.until(() => b.ack && !s.app.inFlight, 30 * SECOND);
  assert.match(b.ack.error, /la commande continue/);
  assert.equal(s.bsb.params[710].value, '22.0');
  assert.ok(
    s.logs.some((l) => /heating-setpoint 22 \(going on\): done/.test(l.line)),
    'confirmed by its read back',
  );
});

test('the read budget counts from getting the adapter, not from the click', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  // A poll batch of 8 s in flight; the fresh read of circuit 2 (5 parameters) 7 s.
  s.bsb.behave = (r) => {
    if (r.endpoint !== '/JQ') {
      return undefined;
    }
    if (r.ids.length === 5) {
      return { delay: 7_000 };
    }
    return r.ids.length > 1 ? { delay: 8_000 } : undefined;
  };
  s.app.tick();
  // Its /JI done, its first /JQ in flight.
  await s.until(() => s.bsb.requests.at(-1).ids.length === 4, 2_000);
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack && !s.app.inFlight, 30 * SECOND);
  assert.match(b.ack.error, /la commande continue/);
  // 15 s after the click, 7.3 s after it got the adapter: within the 12 s.
  assert.equal(s.bsb.params[1010].value, '22.0');
});

test('a Protection during the write of a command: no read back first, the Protection is written next', async (t) => {
  const s = await setup(t);
  s.bsb.behave = (r) =>
    r.endpoint === '/JS' && r.body.Parameter === '710' ? { delay: 2_000 } : undefined;
  const a = s.click('heating-setpoint', 22);
  await s.until(() => s.bsb.requests.some((r) => r.endpoint === '/JS'), 2_000);
  const p = s.click('mode', 'protection');
  await s.until(() => a.ack && p.ack && !s.app.inFlight, 10 * SECOND);
  const i = s.bsb.requests.findIndex((r) => r.endpoint === '/JS');
  assert.deepEqual(
    s.bsb.requests.slice(i, i + 2).map((r) => [r.endpoint, r.body?.Parameter]),
    [
      ['/JS', '710'],
      ['/JS', '700'],
    ],
    'the Protection right after the write',
  );
  assert.match(a.ack.error, /sans confirmation \(not read back: a protective command first\)/);
  assert.equal(s.bsb.params[700].value, '0');
});

// --- Review bsblan-034-r1 -------------------------------------------------------

test('r034 I1 (S1): a newer value of the same setting replaces a slow command not sent yet', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  let slowUntil = -Infinity;
  s.bsb.behave = (r) => {
    const slow = Date.now() < slowUntil;
    if (r.endpoint === '/JS') {
      slowUntil = Date.now() + 1_000 + 12 * SECOND;
      return { delay: 1_000 };
    }
    if (r.endpoint === '/JI') {
      return { delay: slow ? 1_000 : 250 };
    }
    return r.endpoint === '/JQ' ? { delay: r.ids.length * (slow ? 2_200 : 1_600) } : undefined;
  };
  const a = s.click('hc2-setpoint', 22);
  await s.until(() => a.ack);
  assert.match(a.ack.error, /la commande continue/);
  await s.advance(6_000 - (Date.now() - a.at));
  const b = s.click('hc2-setpoint', 23);
  await s.until(() => b.ack && !s.app.inFlight && s.app.waiting.size === 0, 90 * SECOND);
  assert.deepEqual(writes(s.bsb), [['1010', '23.0']], '22 never written after the click of 23');
  assert.equal(s.bsb.params[1010].value, '23.0');
  assert.ok(
    s.logs.some((l) => l.level === 'info' && /hc2-setpoint 22 \(going on\).*replaced/.test(l.line)),
    s.logs.map((l) => `${l.level}: ${l.line}`).join(' | '),
  );
});

test('r034 I1 (S2): a command waiting for the adapter is replaced, the newer one is sent', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  let stall = true;
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JQ' && r.ids.length === 4 && stall) {
      stall = false;
      r.stalled = true;
      return { delay: 14_500 };
    }
    if (r.endpoint === '/JQ' && r.ids.length === 5) {
      return { delay: 11_000 };
    }
    if (r.endpoint === '/JS') {
      return { delay: 3_000 };
    }
    return r.endpoint === '/JQ' && r.ids.length === 1 ? { delay: 3_500 } : undefined;
  };
  s.app.tick();
  await s.until(() => s.bsb.requests.at(-1)?.ids?.length === 4, 3_000);
  const a = s.click('hc2-setpoint', 22);
  await s.advance(500);
  const b = s.click('hc2-setpoint', 23);
  await s.until(() => a.ack && b.ack && !s.app.inFlight && s.app.waiting.size === 0, 90 * SECOND);
  assert.deepEqual(writes(s.bsb), [['1010', '23.0']]);
  assert.equal(s.bsb.params[1010].value, '23.0', 'the last click wins');
  // Replaced right when it got the adapter: not even a /JI for it.
  const after = s.bsb.requests.slice(
    s.bsb.requests.findIndex((r) => r.stalled),
    s.bsb.requests.findIndex((r) => r.endpoint === '/JS'),
  );
  assert.equal(after.filter((r) => r.endpoint === '/JI').length, 1, 'one /JI: the newer command');
  assert.equal(after.filter((r) => r.ids.length === 5).length, 1, 'one fresh read');
});

test('r034 I1: a command that already left is not touched by a newer one', async (t) => {
  const s = await setup(t);
  s.bsb.behave = (r) => (r.endpoint === '/JS' ? { delay: 2_000 } : undefined);
  const a = s.click('heating-setpoint', 22);
  await s.until(() => s.bsb.requests.some((r) => r.endpoint === '/JS'), 2_000);
  const b = s.click('heating-setpoint', 21);
  await s.until(() => a.ack && b.ack && !s.app.inFlight && s.app.waiting.size === 0, 40 * SECOND);
  assert.equal(a.ack.error, undefined, 'the first one confirmed');
  assert.deepEqual(writes(s.bsb), [
    ['710', '22.0'],
    ['710', '21.0'],
  ]);
  assert.equal(s.bsb.params[710].value, '21.0');
});

test('r034 I2 (S5): refused after its own read during the retry delay: the card shows the real value', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  await s.advance(MINUTE);
  const id = feature('hc2-setpoint');
  const before = s.gladys.fake.states.length;
  // 1016 = 26: 26.5 is above the controller's maximum.
  const a = s.click('hc2-setpoint', 26.5);
  await s.until(() => a.ack);
  assert.match(a.ack.error, /non envoyée/);
  await s.advance(2 * SECOND);
  const shown = s.gladys.fake.states
    .slice(before)
    .filter((x) => x.device_feature_external_id === id)
    .map((x) => x.state);
  assert.deepEqual(shown, [21], 'the value read by the command');
  assert.equal(s.app.adapter.online, false, 'still in its retry delay');
});

test('r034 I2: no answer during the retry delay: refused without the "slow adapter" hint, nothing shown', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  s.bsb.behave = (r) => (r.endpoint === '/JI' ? 'timeout' : undefined);
  const id = feature('hc2-setpoint');
  const before = s.gladys.fake.states.length;
  const a = s.click('hc2-setpoint', 22);
  await s.until(() => a.ack);
  assert.ok(a.took < 4_000, `its /JI waited 3 s at most: ${a.took}`);
  assert.match(a.ack.error, /relue juste avant \(timeout\) : commande non envoyée\.$/);
  assert.doesNotMatch(a.ack.error, /lentement/);
  await s.advance(2 * SECOND);
  assert.deepEqual(
    s.gladys.fake.states.slice(before).filter((x) => x.device_feature_external_id === id),
    [],
    'no value known: the card waits for the next read',
  );
});

test('r034 m2: during the retry delay, one own try per 30 s; a Protection is never held by it', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  s.bsb.down = true;
  const before = s.bsb.requests.length;
  const acks = [];
  for (let i = 0; i < 10; i += 1) {
    acks.push(s.click('heating-setpoint', 20 + (i % 3)));
    await s.advance(2_000);
  }
  await s.until(() => acks.every((x) => x.ack) && !s.app.inFlight, 30 * SECOND);
  assert.equal(s.bsb.requests.length - before, 1, 'one /JI for 10 clicks in 20 s');
  assert.match(acks[1].ack.error, /il y a quelques secondes : non envoyée/);
  const p = s.click('mode', 'protection');
  await s.until(() => p.ack, 10 * SECOND);
  assert.equal(s.bsb.requests.at(-1).endpoint, '/JS', 'the Protection tried at once');
  // 30 s after the failed try: a command tries again.
  await s.advance(30 * SECOND);
  const count = s.bsb.requests.length;
  const c = s.click('heating-setpoint', 22);
  await s.until(() => c.ack);
  assert.equal(s.bsb.requests.length, count + 1);
  assert.equal(s.bsb.requests.at(-1).endpoint, '/JI');
});

test('r034 m1 (R12): a command that cannot get the adapter within 15 s is refused unsent', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  // Something holds the adapter 16 s (a request BSB-LAN serves).
  s.app.adapter.client.gate.run(() => new Promise((resolve) => setTimeout(resolve, 16 * SECOND)));
  const before = s.bsb.requests.length;
  const a = s.click('mode', 'reduced');
  await s.until(() => a.ack && !s.app.inFlight, 30 * SECOND);
  await s.advance(2 * SECOND);
  assert.equal(s.bsb.requests.length, before, 'nothing requested');
  assert.deepEqual(writes(s.bsb), []);
  assert.ok(
    s.logs.some(
      (l) => l.level === 'warn' && /mode reduced \(going on\).*trop lentement/.test(l.line),
    ),
    s.logs.map((l) => l.line).join(' | '),
  );
});

test('r034 m1 (R14): a write whose connection cannot open before its limit is not sent', async (t) => {
  const s = await setup(t);
  // The fresh read takes 11.8 s of its 12 s, then the connection of the write 1 s.
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JQ' && r.ids.length > 1) {
      return { delay: 11_800 };
    }
    return r.endpoint === '/JS' ? { connect: 1_000 } : undefined;
  };
  const a = s.click('heating-setpoint', 22);
  await s.until(() => a.ack && !s.app.inFlight, 30 * SECOND);
  assert.equal(s.bsb.params[710].value, '20.0', 'never applied');
  assert.deepEqual(s.bsb.writes(), []);
  assert.ok(
    s.logs.some(
      (l) => l.level === 'warn' && /heating-setpoint 22 \(going on\).*trop lentement/.test(l.line),
    ),
    s.logs.map((l) => l.line).join(' | '),
  );
});

test('r034 m4: a queued command never starts later than 30 s after its click', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  const gate = s.app.adapter.client.gate;
  const hold = (ms) => gate.run(() => new Promise((resolve) => setTimeout(resolve, ms)));
  // The adapter is held 14 s; then the setpoint's fresh read 11 s.
  hold(14 * SECOND);
  let held = false;
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JQ' && r.ids.length === 4) {
      return { delay: 11 * SECOND };
    }
    if (r.endpoint === '/JS' && !held) {
      // While it writes, something else waits for the adapter (6 s).
      held = true;
      hold(6 * SECOND);
    }
    return undefined;
  };
  const a = s.click('heating-setpoint', 22);
  await s.advance(500);
  const b = s.click('mode', 'reduced');
  await s.until(() => a.ack && b.ack && !s.app.inFlight && s.app.waiting.size === 0, 60 * SECOND);
  await s.advance(10 * SECOND);
  assert.equal(s.bsb.params[710].value, '22.0');
  // B leaves the queue about 28 s after its click, the adapter is free about 31 s after it.
  assert.equal(s.bsb.params[700].value, '3', 'the mode never written');
  assert.ok(
    s.logs.some(
      (l) => l.level === 'warn' && /mode reduced \(queued\).*trop lentement/.test(l.line),
    ),
    s.logs.map((l) => l.line).join(' | '),
  );
});

test('r034 I2: a slow own try during the retry delay is answered as a retry, not as a slow adapter', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  s.bsb.behave = (r) => (r.endpoint === '/JQ' && r.ids.length > 1 ? { delay: 5_000 } : undefined);
  const a = s.click('heating-setpoint', 22);
  await s.until(() => a.ack && !s.app.inFlight, 20 * SECOND);
  assert.match(a.ack.error, /n'a pas répondu à la dernière lecture : la commande le relit/);
  assert.equal(s.bsb.params[710].value, '22.0');
});

// --- Review bsblan-034-r2 -------------------------------------------------------

const shownOf = (s, before, role) =>
  s.gladys.fake.states
    .slice(before)
    .filter((x) => x.device_feature_external_id === feature(role))
    .map((x) => x.state);

test('r034-r2 J1 (S11): a value read by an earlier command is never shown again after a failure', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  await s.advance(MINUTE);
  let before = s.gladys.fake.states.length;
  const a = s.click('hc2-setpoint', 26.5);
  await s.until(() => a.ack);
  await s.advance(2 * SECOND);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), [21], 'its own read: shown');
  // Changed on the room unit, then the adapter dies; the polls fail for 2 h.
  s.bsb.params[1010] = { ...s.bsb.params[1010], value: '23.0' };
  s.bsb.down = true;
  await s.advance(2 * 60 * MINUTE, 1_000);
  before = s.gladys.fake.states.length;
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  await s.advance(2 * SECOND);
  assert.match(b.ack.error, /relue juste avant/);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), [], 'never 21 read 2 h ago');
  // Held 30 s: no request, nothing shown either.
  const c = s.click('hc2-setpoint', 22.5);
  await s.until(() => c.ack);
  await s.advance(2 * SECOND);
  assert.match(c.ack.error, /il y a quelques secondes/);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), []);
});

test('r034-r2 J1: a failed own try right after an own read drops that read', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  const a = s.click('hc2-setpoint', 26.5);
  await s.until(() => a.ack);
  s.bsb.down = true;
  const before = s.gladys.fake.states.length;
  const b = s.click('hc2-setpoint', 22);
  await s.until(() => b.ack);
  await s.advance(2 * SECOND);
  assert.match(b.ack.error, /relue juste avant \(unreachable\)/);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), []);
});

test('r034-r2 J1: a good read drops the reads of earlier commands', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  const a = s.click('hc2-setpoint', 26.5);
  await s.until(() => a.ack);
  assert.ok(s.app.offlineFresh.size > 0);
  // The next read succeeds (600 s after the failed one).
  await s.advance(11 * MINUTE, 1_000);
  assert.equal(s.app.adapter.online, true);
  assert.equal(s.app.offlineFresh.size, 0, 'cleared by the good read');
});

test('r034-r2 n1 (N4): a newer value arriving while the write connects stops it', async (t) => {
  const s = await setup(t);
  let first = true;
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JS' && first) {
      first = false;
      return { connect: 1_000 };
    }
    return undefined;
  };
  const a = s.click('heating-setpoint', 22);
  await s.until(() => s.bsb.requests.some((r) => r.endpoint === '/JS'), 2_000);
  const b = s.click('heating-setpoint', 23);
  await s.until(() => a.ack && b.ack && !s.app.inFlight && s.app.waiting.size === 0, 30 * SECOND);
  assert.deepEqual(s.bsb.writes(), [['710', '23.0']], 'the older one never left');
  assert.equal(s.bsb.params[710].value, '23.0');
  assert.ok(
    s.logs.some((l) => l.level === 'info' && /heating-setpoint.*replaced/.test(l.line)),
    s.logs.map((l) => l.line).join(' | '),
  );
});

test('r034-r2 n1 (N8): the 30 s hold of own tries ends as soon as a read succeeds', async (t) => {
  const s = await setup(t);
  // Interval 30 s: a read fails, the next one 30 s later.
  s.bsb.down = true;
  await s.until(() => s.app.adapter.online === false, 40 * SECOND);
  const offlineAt = Date.now();
  await s.advance(10 * SECOND);
  const a = s.click('heating-setpoint', 22);
  await s.until(() => a.ack);
  assert.match(a.ack.error, /relue juste avant \(unreachable\)/);
  s.bsb.down = false;
  await s.until(() => s.app.adapter.online === true, 30 * SECOND);
  assert.ok(Date.now() - offlineAt < 35 * SECOND, 'back before the hold ended');
  assert.ok(s.app.ownTryUntil > Date.now(), 'the hold of the failed try still runs');
  const b = s.click('heating-setpoint', 22);
  await s.until(() => b.ack);
  assert.equal(b.ack.error, undefined, 'online: never held');
  assert.equal(s.bsb.params[710].value, '22.0');
});

test('r034-r2 J1: a failed poll drops the reads of earlier commands (a refusal before any request shows nothing)', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  const a = s.click('hc2-setpoint', 26.5);
  await s.until(() => a.ack);
  s.bsb.params[1010] = { ...s.bsb.params[1010], value: '23.0' };
  s.bsb.down = true;
  // The next poll (600 s) fails.
  await s.advance(11 * MINUTE, 1_000);
  assert.equal(s.app.offlineFresh.size, 0);
  const before = s.gladys.fake.states.length;
  // Refused on arrival (a tenth of a degree only): no request, no read.
  const b = s.click('hc2-setpoint', 22.05);
  await s.until(() => b.ack);
  await s.advance(2 * SECOND);
  assert.ok(b.ack.error);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), [], 'never the 21 read before the failure');
});

test('r034-r2 J1: a stop on refused credentials drops the reads of earlier commands', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await failedPoll(s);
  // Its own read passes, its write gets a 401: a stop on the credentials.
  s.bsb.behave = (r) => (r.endpoint === '/JS' ? { status: 401 } : undefined);
  const a = s.click('hc2-setpoint', 22);
  await s.until(() => a.ack);
  assert.match(a.ack.error, /refusé la commande/);
  s.bsb.behave = undefined;
  // The next tick meets the stop (15 min): nothing requested, halted.
  await s.advance(11 * MINUTE, 1_000);
  assert.equal(s.app.adapter.error, 'auth');
  assert.equal(s.app.offlineFresh.size, 0);
  const before = s.gladys.fake.states.length;
  const b = s.click('hc2-setpoint', 22.05);
  await s.until(() => b.ack);
  await s.advance(2 * SECOND);
  assert.deepEqual(shownOf(s, before, 'hc2-setpoint'), []);
});
