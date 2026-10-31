// -----------------------------------------------------------------------------
// The app on a REAL moving clock (Date.now, setTimeout) and the real HTTP
// transport against a local server playing BSB-LAN 5.0.111 (the forum
// report t/11458: `buswritable` meaningless, parameters read/write). The
// time is sped up (`SPEED`) but it is the real clock: it moves between any
// two reads of it. The app is always stopped in a `finally`.
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
    await app.start({ address: `127.0.0.1:${adapter.port}`, poll_interval: 10 });
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
    await app.start({ address: `127.0.0.1:${adapter.port}`, allow_commands: true });
    assert.ok(app.live, 'read once');
    assert.doesNotMatch(app.status()[1].fr, /lecture seule|ne dit pas/);
    for (let i = 0; i < 20; i += 1) {
      const value = i % 2 === 0 ? 21.5 : 20.5;
      const before = clock.now();
      let error;
      try {
        await app.setValue(device, { external_id: ids.feature('heating-setpoint') }, value);
      } catch (err) {
        error = err.message;
      }
      results.push({ value, error, took: clock.now() - before });
      // The next command after the 3 s spacing (300 ms real).
      await sleep(340);
    }
    // Protection, the option turned off: still sent.
    app.config.allowCommands = false;
    await app.setValue(device, { external_id: ids.feature('mode') }, 'protection');
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
    await app.start({ address: `127.0.0.1:${adapter.port}`, allow_commands: true });
    const reduced = set('mode', 'reduced');
    while (!adapter.hits.some((h) => h.write?.[1] === '2')) {
      await sleep(5);
    }
    await sleep(100);
    const protection = set('mode', 'protection');
    await sleep(200);
    await adapter.refuse();
    await Promise.all([reduced, protection]);
    kept = app.memory.stops.map((k) => [k.role, k.sent]);
    await sleep(1500);
    await adapter.accept();
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
