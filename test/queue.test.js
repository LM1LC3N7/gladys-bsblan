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
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

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
  assert.match(second.ack.error ?? 'success', /attend et part juste après|success/);
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
