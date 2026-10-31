// -----------------------------------------------------------------------------
// The app on a REAL moving clock (Date.now, setTimeout) and the real HTTP
// transport against a local server playing BSB-LAN 5.0.111 (the forum
// report t/11458: `buswritable` meaningless, parameters read/write). The
// time is sped up (`SPEED`) but it is the real clock: it moves between any
// two reads of it. The app is always stopped in a `finally`, and every wait
// is bounded (`waitFor`, `within`): a regression fails the test, never
// hangs the suite.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { CAPTURE_MAC_ID, info5_0_111, jqAnswer5x } from './fixtures/captures.js';

const quiet = () => {};
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };

async function fakeAdapter({ latencyMs = 2, delayOf = () => 0 } = {}) {
  const params = jqAnswer5x();
  const hits = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      hits.push({ path: url.pathname, at: Date.now() });
      let out;
      if (url.pathname === '/JI') {
        out = info5_0_111(0);
      } else if (url.pathname === '/JV') {
        out = { api_version: '2.0' };
      } else if (url.pathname === '/JQ') {
        out = {};
        for (const id of (url.searchParams.get('Parameter') ?? '').split(',')) {
          out[id] = params[id] ?? {
            name: id,
            error: 7,
            value: '---',
            desc: '',
            dataType: 0,
            unit: '',
          };
        }
      } else if (url.pathname === '/JS') {
        const { Parameter: id, Value: value } = JSON.parse(body);
        const ok = params[id] && params[id].readwrite === 0;
        if (ok) {
          params[id] = { ...params[id], value };
        }
        out = { [id]: { status: ok ? 1 : 2, destination: 0 } };
        hits.at(-1).write = [id, value];
      }
      setTimeout(
        () => {
          if (res.destroyed) {
            return;
          }
          res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out ?? {}));
        },
        latencyMs + delayOf(hits.at(-1), body),
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    hits,
    params,
    port,
    /** New connections refused, the open ones still answered. */
    refuse: () => new Promise((resolve) => server.close(() => resolve())),
    accept: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        if (server.listening) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      }),
  };
}

function scaled(speed) {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * speed,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms) / speed),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms / speed)),
      clearInterval: (id) => clearInterval(id),
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()`, `ms` real ms at most: past it, fails (the finally then stops the app). */
async function waitFor(ready, ms, what) {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`not seen within ${ms} ms: ${what}`);
    }
    await sleep(5);
  }
}

/** A promise, `ms` real ms at most: past it, fails. */
function within(promise, ms, what) {
  let handle;
  const late = new Promise((resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`not settled within ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(handle));
}

/** The app's timers, counted: `live` holds those still armed (run or cleared: gone). */
function counted(timers) {
  const live = new Set();
  return {
    live,
    setTimeout(fn, ms) {
      const handle = timers.setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      live.delete(handle);
      timers.clearTimeout(handle);
    },
    setInterval(fn, ms) {
      const handle = timers.setInterval(fn, ms);
      live.add(handle);
      return handle;
    },
    clearInterval(handle) {
      live.delete(handle);
      timers.clearInterval(handle);
    },
  };
}

test('real clock: polls at 0, the interval and twice the interval, never sooner', async () => {
  // x20: the 10 s interval is 500 ms real. Waits for 3 reads (10 s real at
  // most) rather than a fixed time: a loaded runner only delays them.
  const SPEED = 20;
  const adapter = await fakeAdapter();
  const clock = scaled(SPEED);
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const app = new BsbLanApp({ gladys, logger, store: memoryStore(), ...clock });
  const reads = () => adapter.hits.filter((h) => h.path === '/JI').map((h) => h.at);
  try {
    await within(
      app.start({ address: `127.0.0.1:${adapter.port}`, poll_interval: 10 }),
      10_000,
      'start',
    );
    const until = Date.now() + 10_000;
    while (reads().length < 3 && Date.now() < until) {
      await sleep(20);
    }
  } finally {
    app.stop();
    await adapter.close();
  }
  const at = reads();
  assert.ok(at.length >= 3, `${at.length} reads`);
  for (let i = 1; i < 3; i += 1) {
    const gap = (at[i] - at[i - 1]) * SPEED;
    // Counted from the end of a read (its requests take real ms): never
    // sooner than the interval; late only by load (wide margin).
    assert.ok(gap >= 0.9 * 10_000, `never sooner than the interval: ${gap}`);
    assert.ok(gap < 4 * 10_000, `on time: ${gap}`);
  }
});

test('real clock, x20: on 5.0.111 (buswritable 0) commands leave, each confirmed by a read back', async () => {
  const SPEED = 10;
  const adapter = await fakeAdapter();
  const clock = scaled(SPEED);
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const app = new BsbLanApp({ gladys, logger, store: memoryStore(), ...clock });
  const device = { external_id: `ext:test:bsblan:${CAPTURE_MAC_ID}` };
  const ids = gladys.externalIds('bsblan', CAPTURE_MAC_ID);
  const results = [];
  try {
    await within(
      app.start({ address: `127.0.0.1:${adapter.port}`, allow_commands: true }),
      10_000,
      'start',
    );
    assert.ok(app.live, 'read once');
    assert.doesNotMatch(app.status()[1].fr, /lecture seule|ne dit pas/);
    for (let i = 0; i < 20; i += 1) {
      const value = i % 2 === 0 ? 21.5 : 20.5;
      const before = clock.now();
      let error;
      try {
        await within(
          app.setValue(device, { external_id: ids.feature('heating-setpoint') }, value),
          10_000,
          `command ${i}`,
        );
      } catch (err) {
        error = err.message;
      }
      results.push({ value, error, took: clock.now() - before });
      // The next command after the 3 s spacing (300 ms real).
      await sleep(340);
    }
    // Protection, the option turned off: still sent.
    app.config.allowCommands = false;
    await within(
      app.setValue(device, { external_id: ids.feature('mode') }, 'protection'),
      10_000,
      'Protection',
    );
  } finally {
    app.stop();
    await adapter.close();
  }
  for (const r of results) {
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.ok(r.took < 4_300, `answered by 4.3 s: ${r.took}`);
  }
  assert.equal(adapter.params[710].value, '20.5');
  assert.equal(adapter.params[700].value, '0');
  assert.equal(adapter.hits.filter((h) => h.path === '/JS').length, 21);
});

test('real clock (B1): Protection clicked while an older write waits for its answer, adapter lost: kept, sent when back', async () => {
  // The Reduced write is answered 800 ms after it arrives.
  const adapter = await fakeAdapter({
    delayOf: (hit, body) => (hit.path === '/JS' && body.includes('"Value":"2"') ? 800 : 0),
  });
  const clock = scaled(1);
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const app = new BsbLanApp({ gladys, logger, store: memoryStore(), ...clock });
  const device = { external_id: `ext:test:bsblan:${CAPTURE_MAC_ID}` };
  const ids = gladys.externalIds('bsblan', CAPTURE_MAC_ID);
  const set = (role, value) =>
    app.setValue(device, { external_id: ids.feature(role) }, value).then(
      () => 'ok',
      (err) => err.message,
    );
  let kept;
  try {
    await within(
      app.start({ address: `127.0.0.1:${adapter.port}`, allow_commands: true }),
      10_000,
      'start',
    );
    const reduced = set('mode', 'reduced');
    await waitFor(
      () => adapter.hits.some((h) => h.write?.[1] === '2'),
      10_000,
      'the Reduced write',
    );
    await sleep(100);
    const protection = set('mode', 'protection');
    await sleep(200);
    await within(adapter.refuse(), 10_000, 'connections refused');
    await within(Promise.all([reduced, protection]), 15_000, 'both commands answered');
    kept = app.memory.stops.map((k) => [k.role, k.sent]);
    await sleep(1500);
    await within(adapter.accept(), 10_000, 'connections accepted');
    // The retry of a stop not sent runs every 10 s.
    const until = Date.now() + 13_000;
    while (Date.now() < until && adapter.params[700].value !== '0') {
      await sleep(50);
    }
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.deepEqual(kept, [['mode', 0]], 'kept, never lifted by the older write');
  assert.equal(adapter.params[700].value, '0');
});

// --- stop() (review r3, I1) ----------------------------------------------------
// After stop(), nothing is armed again and nothing more is requested: a test
// (or any process) that stops its app can exit. Real clock x10, the app's
// timers counted, and counted BEFORE the safety stop() of the `finally`
// (which clears them).

const SPEED_STOP = 10;

async function stoppable({ delayOf, store = memoryStore() } = {}) {
  const adapter = await fakeAdapter({ delayOf });
  const clock = scaled(SPEED_STOP);
  const timers = counted(clock.timers);
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const app = new BsbLanApp({ gladys, logger, store, now: clock.now, timers });
  const device = { external_id: `ext:test:bsblan:${CAPTURE_MAC_ID}` };
  const ids = gladys.externalIds('bsblan', CAPTURE_MAC_ID);
  const set = (role, value) =>
    within(
      app.setValue(device, { external_id: ids.feature(role) }, value),
      15_000,
      `${role} ${value}`,
    ).then(
      () => 'ok',
      (err) => err.message,
    );
  const config = (more = {}) => ({
    address: `127.0.0.1:${adapter.port}`,
    poll_interval: 600,
    ...more,
  });
  return { adapter, timers, gladys, app, set, config };
}

test('real clock (r3 I1): a kept stop rejected in the queue by stop() is never tried again; no timer left', async () => {
  let slow = false;
  const { adapter, timers, app, set, config } = await stoppable({
    delayOf: (hit) => (slow && hit.path === '/JQ' ? 1500 : 0),
  });
  let left;
  let tries = 0;
  let hits;
  try {
    await within(app.start(config()), 10_000, 'start');
    // Not sent (connections refused): kept, retried every 10 s.
    await within(adapter.refuse(), 10_000, 'connections refused');
    await set('mode', 'protection');
    assert.deepEqual(
      app.memory.stops.map((k) => [k.role, k.sent]),
      [['mode', 0]],
    );
    await within(adapter.accept(), 10_000, 'connections accepted');
    // A read whose /JQ is slow: its /JI shows the MAC, the stop is queued
    // at once behind that /JQ (s10-after-stop of the review).
    slow = true;
    const count = adapter.hits.length;
    const read = app.tick();
    // The slow /JQ arrived at the adapter (it answers 1.5 s later), the stop waits behind it.
    await waitFor(
      () => app.stopFlight.size > 0 && adapter.hits.slice(count).some((h) => h.path === '/JQ'),
      10_000,
      'the stop queued behind the read',
    );
    assert.equal(app.memory.stops[0].sent, 0, 'still not sent when stop() is called');
    const sendStop = app.sendStop.bind(app);
    app.sendStop = (...args) => {
      tries += 1;
      return sendStop(...args);
    };
    hits = adapter.hits.length;
    app.stop();
    await within(read, 10_000, 'the read in flight');
    // 35 s: three times the 10 s retry.
    await sleep(3_500);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.equal(tries, 0, 'never tried again after stop()');
  assert.equal(adapter.hits.length, hits, 'nothing requested after stop()');
  assert.equal(left, 0, 'no timer left');
  assert.equal(app.memory.stops.length, 1, 'still kept (in /data): it leaves at the next start');
});

test('real clock (r3 I1): a write in flight when stop() is called arms no read and no timer', async () => {
  const { adapter, timers, app, set, config } = await stoppable({
    delayOf: (hit) => (hit.path === '/JS' ? 600 : 0),
  });
  let left;
  let hits;
  let answer;
  let liveAtAnswer;
  try {
    await within(app.start(config({ allow_commands: true })), 10_000, 'start');
    const reduced = set('mode', 'reduced');
    await waitFor(() => adapter.hits.some((h) => h.write), 10_000, 'the write');
    hits = adapter.hits.length;
    app.stop();
    answer = await reduced;
    liveAtAnswer = timers.live.size;
    // 25 s: past the follow-up reads (5 s and 20 s after a write).
    await sleep(2_500);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.match(answer, /sans confirmation/);
  assert.equal(liveAtAnswer, 0, 'no follow-up read armed');
  assert.equal(adapter.hits.length, hits, 'nothing requested after stop()');
  assert.equal(left, 0, 'no timer left');
});

test('real clock (r3 I1): the test button after stop() reads nothing and arms nothing', async () => {
  const { adapter, timers, app, config } = await stoppable();
  let left;
  let hits;
  try {
    await within(app.start(config()), 10_000, 'start');
    app.stop();
    hits = adapter.hits.length;
    await within(app.testConnection(), 10_000, 'the test button');
    await sleep(300);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.equal(adapter.hits.length, hits, 'nothing requested after stop()');
  assert.equal(left, 0, 'no timer left');
});

test('real clock (r3 I1): getConfig() settling after stop() neither starts nor retries', async () => {
  const { adapter, timers, gladys, app, config } = await stoppable();
  let left;
  let calls = 0;
  let liveAfterFailure;
  const status = gladys.fake.connectionStatus;
  try {
    const failing = app.connectedWith(() => {
      calls += 1;
      return new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 50));
    });
    app.stop();
    await within(failing, 10_000, 'getConfig() failing');
    liveAfterFailure = timers.live.size;
    const answering = app.connectedWith(
      () => new Promise((resolve) => setTimeout(() => resolve(config()), 50)),
    );
    await within(answering, 10_000, 'getConfig() answering');
    // 7 s: past the first retry (5 s).
    await sleep(700);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.equal(liveAfterFailure, 0, 'no retry armed');
  assert.equal(calls, 1, 'never asked again');
  assert.deepEqual(gladys.fake.connectionStatus, status, 'no status after stop()');
  assert.equal(app.adapter, undefined, 'not started');
  assert.equal(adapter.hits.length, 0, 'nothing requested');
  assert.equal(left, 0, 'no timer left');
});

test('real clock (r3 I1): getConfig() failed, stop() while its status is sent: never retried', async () => {
  const { adapter, timers, gladys, app } = await stoppable();
  let left;
  const setConnectionStatus = gladys.setConnectionStatus.bind(gladys);
  let said = 0;
  gladys.setConnectionStatus = (...args) => {
    said += 1;
    return sleep(100).then(() => setConnectionStatus(...args));
  };
  let calls = 0;
  try {
    const failing = app.connectedWith(async () => {
      calls += 1;
      throw new Error('timeout');
    });
    await waitFor(() => said > 0, 10_000, 'the status sent');
    app.stop();
    await within(failing, 10_000, 'getConfig() failing');
    // 7 s: past the first retry (5 s).
    await sleep(700);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.equal(calls, 1, 'never asked again');
  assert.equal(left, 0, 'no timer left');
});

test('real clock (r3 I1): a start or a new configuration in progress when stop() is called arms nothing', async () => {
  const { adapter, timers, app, config } = await stoppable();
  let left;
  let hits;
  try {
    // stop() while start() reads /data: that start goes no further.
    const starting = app.start(config());
    app.stop();
    await within(starting, 10_000, 'start');
    assert.equal(app.adapter, undefined, 'not started');
    assert.equal(adapter.hits.length, 0, 'nothing requested');
    assert.equal(timers.live.size, 0, 'no timer left after the start');
    // Started, then other credentials saved: stop() while /data is saved.
    await within(app.start(config()), 10_000, 'start');
    const saving = app.configUpdated(config({ username: 'u', password: 'p' }));
    app.stop();
    hits = adapter.hits.length;
    await within(saving, 10_000, 'other credentials');
    // Another interval saved after stop().
    await within(app.configUpdated(config({ poll_interval: 60 })), 10_000, 'another interval');
    await sleep(300);
    left = timers.live.size;
  } finally {
    app.stop();
    await adapter.close();
  }
  assert.equal(adapter.hits.length, hits, 'nothing requested after stop()');
  assert.equal(left, 0, 'no timer left');
  assert.equal(app.config.username, '', 'not started again with the new credentials');
  assert.equal(app.config.pollInterval, 600, 'nor with the new interval');
});
