// -----------------------------------------------------------------------------
// Mutants of the fixes for forum t/11458 n° 9 and review bsblan-032-r3 (m1, m2).
// Each one breaks one fix; the whole suite must fail, never hang. Run one at a
// time in a private copy of the repository (never the working tree), under a
// RAM cap and a deadline that kills the whole process group:
//
//   node scripts/mutants.mjs [names...]
//
// Needs `memcap`, `setsid` and `timeout` (the dev VM). Not in the image.
// -----------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);

const GUARD = '      mark.cap = Math.max(mark.cap, this.now() + TIMINGS.reshowMax);\n';
const HELD =
  '        if (online && mark.left && (this.paramSeqs.get(mark.param) ?? 0) <= mark.seq) {';

/** [name, file, from, to]: `from` must occur exactly once. */
const MUTANTS = [
  // 1. Waiting and replaced: info, two distinct lines.
  ['L1-replaced-no-notice', 'src/app.js', '      replaced.notice = NOTICES.replaced;\n', ''],
  ['L2-queued-no-notice', 'src/app.js', '      err.notice = NOTICES.queued;\n', ''],
  [
    'L3-no-info-on-arrival',
    'src/app.js',
    '    this.logger.info(`BSB-LAN ${target.role} ${wanted.value} ${noticeLine(NOTICES.queued)}`);\n',
    '',
  ],
  [
    'L4-replaced-as-warning',
    'src/notices.js',
    '    logger?.info(`${what} ${LINES[NOTICES.replaced]}`);',
    '    logger?.warn(`${what} ${LINES[NOTICES.replaced]}`);',
  ],
  [
    'L5-queued-answer-as-warning',
    'src/notices.js',
    '    logger?.debug(`${what} answered: ${LINES[NOTICES.queued]}`);',
    '    logger?.warn(`${what} answered: ${LINES[NOTICES.queued]}`);',
  ],
  [
    'L6-one-line-for-both',
    'src/notices.js',
    "  [NOTICES.replaced]: 'not sent: replaced by a newer value of the same setting',",
    "  [NOTICES.replaced]: 'waiting: another command to BSB-LAN is running, sent after it',",
  ],
  [
    'L7-late-path-old-warning',
    'src/app.js',
    '        logOutcome(\n          this.logger,',
    '        ((logger, what, err) => logger.warn(`${what}: ${err.message}`))(\n          this.logger,',
  ],
  [
    'L8-other-refusals-as-info',
    'src/notices.js',
    '  logger?.warn(`${warned}: ${err?.message}`);',
    '  logger?.info(`${warned}: ${err?.message}`);',
  ],
  // 3. Sending to Gladys failed: once per outage, then the return.
  [
    'P1-every-failure-logged',
    'src/publisher.js',
    '      if (!this.failing) {\n        this.failing = true;',
    '      if (true) {\n        this.failing = true;',
  ],
  [
    'P2-no-return-line',
    'src/publisher.js',
    "        this.logger?.info('Sending to Gladys works again');\n",
    '',
  ],
  [
    'P3-failing-never-reset',
    'src/publisher.js',
    '      if (this.failing) {\n        this.failing = false;',
    '      if (this.failing) {\n        this.failing = true;',
  ],
  [
    'P4-interval-logs-again',
    'src/publisher.js',
    '      this.flush().catch(() => {});',
    '      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));',
  ],
  [
    'P5-app-flush-logs-again',
    'src/app.js',
    '    await this.publisher.flush().catch(() => {});',
    '    await this.publisher\n      .flush()\n      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));',
  ],
  // r032-r3 m1: the refusal under the guard gets its own 10 minutes.
  ['C1-cap-not-extended', 'src/app.js', GUARD, ''],
  [
    'C2-cap-extended-less',
    'src/app.js',
    GUARD,
    '      mark.cap = Math.max(mark.cap, this.now() + TIMINGS.reshowMax / 20);\n',
  ],
  // r032-r3 m2: twins held with their setting.
  ['T1-twins-never-held', 'src/app.js', HELD, '        if (false) {'],
  [
    'T2-twins-held-offline',
    'src/app.js',
    HELD,
    '        if (mark.left && (this.paramSeqs.get(mark.param) ?? 0) <= mark.seq) {',
  ],
  ['T3-twins-held-after-read', 'src/app.js', HELD, '        if (online && mark.left) {'],
  ['T4-mode-without-twin', 'src/app.js', '  [F.MODE]: [F.MODE_STATE],\n', ''],
];

function apply(file, from, to) {
  const text = readFileSync(file, 'utf8');
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${count} occurrences of ${JSON.stringify(from.slice(0, 60))}`);
  }
  writeFileSync(
    file,
    text.replace(from, () => to),
  );
}

// A private copy (node_modules copied, never linked), removed at the end.
const work = mkdtempSync(join(tmpdir(), 'bsblan-mutants-'));
let survivors = 0;
try {
  const copy = join(work, 'repo');
  cpSync(repo, copy, { recursive: true, filter: (src) => !src.includes(`${repo}/.git`) });
  for (const [name, file, from, to] of MUTANTS) {
    if (only.length > 0 && !only.includes(name)) {
      continue;
    }
    const path = join(copy, file);
    const original = readFileSync(path, 'utf8');
    let line;
    try {
      apply(path, from, to);
      const started = Date.now();
      const run = spawnSync(
        'setsid',
        [
          'memcap',
          '-m',
          '3G',
          'timeout',
          '-k',
          '5',
          '300',
          'node',
          '--test',
          '--test-timeout=60000',
        ],
        { cwd: copy, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      const out = `${run.stdout}${run.stderr}`;
      const failed = /ℹ fail (\d+)/.exec(out)?.[1];
      const hung = run.status === 124 || run.status === 137;
      const killed = !hung && failed !== undefined && failed !== '0';
      if (!killed) {
        survivors += 1;
      }
      const verdict = hung ? `HUNG(${run.status})` : killed ? 'KILLED' : 'SURVIVED';
      line = `${name}: ${verdict} (fail ${failed}, ${Math.round((Date.now() - started) / 1000)} s)`;
    } catch (err) {
      survivors += 1;
      line = `${name}: ERROR ${err.message}`;
    } finally {
      writeFileSync(path, original);
    }
    console.log(line);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = survivors > 0 ? 1 : 0;
