import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR } from '../src/constants.js';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 19);

test('the memory is bounded and repaired', () => {
  assert.deepEqual(normalizeMemory(null, NOW), { pausedUntil: 0, auth: { failures: 0, until: 0 } });
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
  const memory = { pausedUntil: NOW + 60_000, auth: { failures: 1, until: NOW + HOUR } };
  await store.save(serializeMemory(memory));
  assert.deepEqual(await store.load(), memory);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(), [
    'auth',
    'pausedUntil',
  ]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});
