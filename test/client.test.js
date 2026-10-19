// -----------------------------------------------------------------------------
// The real transport (node:http) and the client against a loopback server
// (127.0.0.1 only), and the Gate.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BsbClient, Gate, decodeBody, retryAfterMs } from '../src/bsblan/client.js';
import { CODES } from '../src/bsblan/errors.js';
import { httpRequest } from '../src/bsblan/http.js';

async function server(t, handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => s.close(resolve)));
  return { port: s.address().port, seen, server: s };
}

const client = (port, options = {}) =>
  new BsbClient({ address: { host: '127.0.0.1', port }, ...options });

test('POST /JQ with the passkey first and basic auth; /JS with its JSON body', async (t) => {
  const { port, seen } = await server(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url.includes('/JS') ? '{"700":{"status":1}}' : '{"700":{"value":"3"}}');
  });
  const c = client(port, { passkey: 'k3y', username: 'admin', password: 'pw' });
  assert.deepEqual(await c.query(['700', '710']), { 700: { value: '3' } });
  assert.deepEqual(await c.raw.set('710', '21.5'), { 700: { status: 1 } });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/k3y/JQ?Parameter=700,710');
  assert.equal(
    seen[0].headers.authorization,
    `Basic ${Buffer.from('admin:pw').toString('base64')}`,
  );
  assert.equal(seen[1].url, '/k3y/JS');
  assert.deepEqual(JSON.parse(seen[1].body), { Parameter: '710', Value: '21.5', Type: '1' });
  assert.equal(seen[1].headers['content-type'], 'application/json');
  c.close();
});

test('no authorization header without both fields; no passkey prefix without a passkey', async (t) => {
  const { port, seen } = await server(t, (req, res) => res.end('{}'));
  const c = client(port, { username: 'admin' });
  await c.info();
  assert.equal(seen[0].url, '/JI');
  assert.equal(seen[0].headers.authorization, undefined);
  c.close();
});

test('HTTP errors keep their status and Retry-After; nothing of the body', async (t) => {
  const { port } = await server(t, (req, res) => {
    res.statusCode = req.url === '/JI' ? 429 : 401;
    res.setHeader('retry-after', '120');
    res.end('secret page');
  });
  const c = client(port);
  await assert.rejects(c.info(), (err) => {
    assert.equal(err.code, CODES.HTTP);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 120_000);
    assert.equal(err.sent, true);
    assert.doesNotMatch(err.message, /secret/);
    return true;
  });
  await assert.rejects(c.apiVersion(), (err) => err.status === 401);
  c.close();
});

test('an answer above 64 KB, not JSON, or an array is refused', async (t) => {
  let mode = 'big';
  const { port } = await server(t, (req, res) => {
    if (mode === 'big') {
      res.end('{"a":"' + 'x'.repeat(70 * 1024) + '"}');
    } else if (mode === 'html') {
      res.end('<html>');
    } else {
      res.end('[1,2]');
    }
  });
  const c = client(port);
  await assert.rejects(c.info(), (err) => err.code === CODES.TOO_LARGE && err.sent);
  mode = 'html';
  await assert.rejects(c.info(), (err) => err.code === CODES.BAD_ANSWER);
  mode = 'array';
  await assert.rejects(c.info(), (err) => err.code === CODES.BAD_ANSWER);
  c.close();
});

test('a Latin-1 body is decoded (python-bsblan _read_json)', () => {
  const body = Buffer.concat([Buffer.from('{"u":"'), Buffer.from([0xb0]), Buffer.from('C"}')]);
  assert.deepEqual(decodeBody(body), { u: '°C' });
});

test('a silence after the connection is a timeout that may have been sent', async (t) => {
  const { port } = await server(t, () => {});
  await assert.rejects(
    httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/JS',
      body: '{}',
      timeout: 300,
      maxBytes: 1000,
    }),
    (err) => err.code === CODES.TIMEOUT && err.sent === true,
  );
});

test('nothing listening: unreachable, not sent', async (t) => {
  const { port, server: s } = await server(t, () => {});
  await new Promise((resolve) => s.close(resolve));
  await assert.rejects(
    httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/JI',
      timeout: 2000,
      maxBytes: 1000,
    }),
    (err) => err.code === CODES.UNREACHABLE && err.sent === false,
  );
});

test('a header Node refuses is a failure, never a crash', async () => {
  await assert.rejects(
    httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port: 9,
      path: '/JI',
      headers: { authorization: 'Basic ​' },
      timeout: 1000,
      maxBytes: 1000,
    }),
    (err) => err.sent === false,
  );
});

test('a request past its startBy or answerBy is refused LATE, unsent', async () => {
  let called = 0;
  const c = new BsbClient({
    address: { host: 'h', port: 80 },
    request: async () => {
      called += 1;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    },
  });
  await assert.rejects(
    c.raw.set('700', '1', { startBy: Date.now() - 1 }),
    (e) => e.code === CODES.LATE,
  );
  await assert.rejects(
    c.raw.query(['700'], { answerBy: Date.now() - 1 }),
    (e) => e.code === CODES.LATE,
  );
  await assert.rejects(
    c.raw.set('700', '1', {
      beforeSend: () => {
        throw new Error('stop');
      },
    }),
    (e) => e.beforeSend === true,
  );
  assert.equal(called, 0);
  assert.throws(() => c.raw.query(['700;x']), /bad parameter ids/);
});

test('the Gate: one at a time, priority first, LATE at startBy, CLOSED on close', async () => {
  const gate = new Gate();
  const order = [];
  let release;
  const first = gate.run(() =>
    new Promise((resolve) => (release = resolve)).then(() => order.push('a')),
  );
  const second = gate.run(async () => order.push('b'));
  const urgent = gate.run(async () => order.push('c'), { priority: true });
  const late = gate.run(async () => order.push('late'), {
    priority: true,
    startBy: Date.now() + 20,
  });
  late.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  release();
  await Promise.all([first, second, urgent]);
  await assert.rejects(late, (err) => err.code === CODES.LATE);
  assert.deepEqual(order, ['a', 'c', 'b']);
  const blocker = gate.run(() => new Promise(() => {}));
  const queued = gate.run(async () => 1);
  gate.close();
  await assert.rejects(queued, (err) => err.code === CODES.CLOSED);
  void blocker;
});

test('Retry-After: seconds or a date', () => {
  assert.equal(retryAfterMs('30', 0), 30_000);
  assert.equal(retryAfterMs(undefined, 0), undefined);
  assert.equal(retryAfterMs('soon', 0), undefined);
  const now = Date.UTC(2026, 9, 19);
  assert.equal(retryAfterMs(new Date(now + 60_000).toUTCString(), now), 60_000);
});
