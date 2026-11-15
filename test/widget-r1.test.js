// -----------------------------------------------------------------------------
// Review bsblan-040-r1 (0.4.0): the dashboard widget against the rule of the
// core (a nudge within 10 s of the previous accepted one is dropped, a
// content kept `ttl_seconds`). A simulated dashboard pulls on each accepted
// nudge and when the TTL ends; we measure how long it shows a content other
// than the module's. Also: a pause or refused credentials shown as such
// (m1), no nudge after stop() (M21), contradictory bounds of the last read
// never shown as a range (M16). SDK fake Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { WIDGET_KEY } from '../src/widget.js';
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

async function setup(t, { config = {}, bsb = fakeBsbLan({ params: fullParams() }) } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const silent = () => {};
  const logger = { debug: silent, info: silent, warn: silent, error: silent };
  const gladys = createFakeGladys({ config: { address: HOST, allow_commands: true, ...config } });
  // The rule of the core on nudges, and a dashboard that pulls.
  const core = { nudges: [], accepted: [], last: undefined, shown: undefined, expires: 0 };
  const pull = async () => {
    const ack = await gladys.fake.widgetGet(WIDGET_KEY, { language: 'en' });
    const content = ack.data?.content ?? ack.data;
    core.shown = JSON.stringify(content.components);
    core.expires = Date.now() + content.ttl_seconds * 1000;
  };
  gladys.requestWidgetRefresh = () => {
    const now = Date.now();
    core.nudges.push(now);
    if (core.last !== undefined && now - core.last < 10 * SECOND) {
      return; // dropped by the core
    }
    core.last = now;
    core.accepted.push(now);
    core.pending = true;
  };
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  const stale = { run: 0, max: 0 };
  const advance = async (ms, step = 100) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle();
      if (core.pending || (core.shown && Date.now() >= core.expires)) {
        core.pending = false;
        await pull();
      }
      if (core.shown) {
        if (JSON.stringify(app.widgetOf('en').components) !== core.shown) {
          stale.run += step;
          stale.max = Math.max(stale.max, stale.run);
        } else {
          stale.run = 0;
        }
      }
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
  await pull(); // a dashboard opens
  const click = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    gladys.fake.setValue(d, target, value);
  };
  return { gladys, app, bsb, advance, click, core, stale, pull };
}

const spacedBy10s = (times) => times.every((x, i) => i === 0 || x - times[i - 1] >= 10 * SECOND);

test('r1 I1 (W5): a status change 5 s after a command reaches the dashboard within the spacing', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  s.bsb.behave = (r) => {
    if (r.endpoint === '/JS') {
      // The controller switches circuit 2 to comfort heating just after the write.
      s.bsb.params[8001] = { ...s.bsb.params[8001], value: '114', desc: 'Heating mode comfort' };
    }
    return undefined;
  };
  s.stale.max = 0;
  s.click('hc2-setpoint', 22.5);
  await s.advance(11 * MINUTE);
  assert.ok(s.core.shown.includes('Heating mode comfort'), 'the new status is shown');
  assert.equal(s.core.nudges.length, s.core.accepted.length, 'no nudge dropped by the core');
  assert.ok(spacedBy10s(s.core.nudges));
  assert.ok(s.stale.max <= 11 * SECOND, `old content shown ${s.stale.max} ms`);
});

for (const interval of [30, 600]) {
  test(`r1 I1 (W2, interval ${interval} s): the adapter stops answering 3 s after a command`, async (t) => {
    const s = await setup(t, { config: { poll_interval: interval } });
    s.stale.max = 0;
    s.click('hc2-setpoint', 22.5);
    await s.advance(3 * SECOND);
    s.bsb.down = true;
    await s.advance(Math.max(2 * MINUTE, interval * SECOND + 30 * SECOND));
    assert.equal(s.app.live, false);
    assert.match(s.core.shown, /does not answer/);
    assert.equal(s.core.nudges.length, s.core.accepted.length, 'no nudge dropped by the core');
    assert.ok(s.stale.max <= 11 * SECOND, `old content shown ${s.stale.max} ms`);
  });
}

test('r1 m3 (W3): interval 10 s, values changing at every read: one nudge per 11 s at most', async (t) => {
  const s = await setup(t, { config: { poll_interval: 10 } });
  const before = s.core.nudges.length;
  for (let i = 0; i < 30; i += 1) {
    s.bsb.params[8740] = { ...s.bsb.params[8740], value: (19 + (i % 10) / 10).toFixed(1) };
    if (i % 2 === 0) {
      s.click('heating-setpoint', 20 + (i % 4) / 2);
    }
    await s.advance(10 * SECOND);
  }
  const count = s.core.nudges.length - before;
  assert.ok(count <= 30, `${count} nudges in 300 s`);
  assert.equal(s.core.nudges.length, s.core.accepted.length, 'none dropped by the core');
  assert.ok(s.stale.max <= 11 * SECOND, `old content shown ${s.stale.max} ms`);
});

test('r1 I1: a reconnection to Gladys nudges again (a nudge sent meanwhile was lost)', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  await s.advance(20 * SECOND);
  const before = s.core.nudges.length;
  await s.app.connectedWith(async () => ({
    address: HOST,
    allow_commands: true,
    poll_interval: 600,
  }));
  await s.advance(12 * SECOND);
  assert.equal(s.core.nudges.length, before + 1, 'one nudge, even with the same content');
});

test('r1 I1: the TTL is the read interval, at most 60 s', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  const ack = await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'en' });
  assert.equal((ack.data?.content ?? ack.data).ttl_seconds, 60);
});

test('r1 M21: nothing nudged after stop(), and the deferred nudge is cleared', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  // A first change: nudged now; a second one within 11 s: deferred.
  s.app.adapter.values = { ...s.app.adapter.values, room: 12.5 };
  s.app.nudgeWidget();
  s.app.adapter.values = { ...s.app.adapter.values, room: 13.5 };
  s.app.nudgeWidget();
  const nudges = s.core.nudges.length;
  assert.ok(s.app.widgetTimer !== undefined, 'deferred');
  s.app.stop();
  assert.equal(s.app.widgetTimer, undefined, 'cleared by stop()');
  s.app.adapter.values = { ...s.app.adapter.values, room: 14.5 };
  s.app.nudgeWidget({ force: true });
  await s.advance(30 * SECOND);
  assert.equal(s.core.nudges.length, nudges, 'nothing after stop()');
});

test('r1 m1: a pause (503) or refused credentials show their status, not "does not answer"', async (t) => {
  const s = await setup(t, { config: { poll_interval: 30 } });
  s.bsb.behave = () => ({ status: 503 });
  await s.advance(40 * SECOND);
  assert.equal(s.app.live, false);
  assert.match(s.core.shown, /busy or failing \(HTTP 429 or 5xx\): paused/);
  assert.doesNotMatch(s.core.shown, /does not answer/);
  const fr = await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  assert.match(JSON.stringify(fr.data?.content ?? fr.data), /occupé ou en erreur/);
});

test('r1 m1: refused credentials show their status', async (t) => {
  const s = await setup(t, { config: { poll_interval: 30 } });
  s.bsb.behave = () => ({ status: 401 });
  await s.advance(40 * SECOND);
  assert.equal(s.app.live, false);
  assert.match(s.core.shown, /user name and a password|refused the user name/);
  assert.doesNotMatch(s.core.shown, /does not answer/);
});

test('r1 M16: contradictory bounds at the last read are never given as a range', async (t) => {
  const s = await setup(t);
  s.app.adapter.values = { ...s.app.adapter.values, heating2SetpointReduced: 25, heating2Max: 22 };
  assert.throws(() => s.app.parseCommand('hc2-setpoint', 2, MAC_ID), {
    message:
      'Consigne de 2 °C refusée : elle doit être comprise entre 5 et 35 °C (limites du module) ; non envoyée.',
  });
});

test('r2 n2: three changes in the window, then stop(): no timer left (one timer at most)', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  for (const room of [12.5, 13.5, 14.5]) {
    s.app.adapter.values = { ...s.app.adapter.values, room };
    s.app.nudgeWidget();
  }
  s.app.stop();
  let calls = 0;
  s.app.nudgeWidget = () => {
    calls += 1;
  };
  await s.advance(30 * SECOND);
  assert.equal(calls, 0, 'no timer of the widget fired after stop()');
});

test('r2 n1: a dashboard pulling while a nudge waits does not cancel it (other dashboards)', async (t) => {
  const s = await setup(t, { config: { poll_interval: 600 } });
  s.app.adapter.values = { ...s.app.adapter.values, room: 12.5 };
  s.app.nudgeWidget();
  const first = s.core.nudges.length;
  s.app.adapter.values = { ...s.app.adapter.values, room: 13.5 };
  s.app.nudgeWidget();
  assert.ok(s.app.widgetTimer !== undefined, 'deferred');
  // Another dashboard (French) pulls the new content meanwhile.
  await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  await s.advance(12 * SECOND);
  assert.equal(s.core.nudges.length, first + 1, 'the deferred nudge went anyway');
  assert.ok(s.core.shown.includes('13.5'));
});
