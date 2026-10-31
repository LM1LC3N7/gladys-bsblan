import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR } from '../src/constants.js';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 19);

test('the memory is bounded and repaired', () => {
  assert.deepEqual(normalizeMemory(null, NOW), {
    pausedUntil: 0,
    auth: { failures: 0, until: 0 },
    stops: [],
  });
  const m = normalizeMemory(
    { pausedUntil: NOW + 100 * HOUR, auth: { failures: 2.5, until: NOW - 1 } },
    NOW,
  );
  assert.equal(m.pausedUntil, NOW + 6 * HOUR);
  assert.deepEqual(m.auth, { failures: 0, until: 0 });
  const kept = normalizeMemory({ auth: { failures: 3, until: NOW + HOUR } }, NOW);
  assert.deepEqual(kept.auth, { failures: 3, until: NOW + HOUR });
  const polluted = normalizeMemory(JSON.parse('{"__proto__": {"pausedUntil": 9e15}}'), NOW);
  assert.equal(polluted.pausedUntil, 0);
});

test('the file: written atomically, 0600 where it applies, no secret in it', async (t) => {
  // Inside the repository (data/ is ignored by git), never in the system temp folder.
  const base = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'test-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  const memory = {
    pausedUntil: NOW + 60_000,
    auth: { failures: 1, until: NOW + HOUR },
    stops: [{ mac: '008041196990', role: 'mode', from: 'comfort', sent: 1, diff: 0 }],
  };
  await store.save(serializeMemory(memory));
  assert.deepEqual(await store.load(), memory);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(), [
    'auth',
    'pausedUntil',
    'stops',
  ]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('kept stops: repaired, never aged; a file there but unreadable is not empty', async (t) => {
  const m = normalizeMemory(
    {
      stops: [
        { mac: '008041196990', role: 'mode', from: 'comfort', sent: 'x', diff: 9 },
        { mac: '008041196990', role: 'mode', sent: 2 },
        { mac: 'nope', role: 'mode' },
        { mac: '008041196990', role: 'heating-setpoint' },
        { mac: '008041196990', role: 'dhw-mode-select', from: '__proto__', sent: 3 },
      ],
    },
    NOW,
  );
  assert.deepEqual(m.stops, [
    { mac: '008041196990', role: 'mode', from: 'comfort', sent: 0, diff: 1 },
    { mac: '008041196990', role: 'dhw-mode-select', from: undefined, sent: 3, diff: 0 },
  ]);
  const base = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'test-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A directory where the file should be: there, not readable.
  await mkdir(join(dir, 'state.json'));
  await assert.rejects(fileStore(join(dir, 'state.json')).load(), /unreadable/);
  assert.equal(await fileStore(join(dir, 'missing.json')).load(), null);
});
