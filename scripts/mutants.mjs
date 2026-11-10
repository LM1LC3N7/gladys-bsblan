// -----------------------------------------------------------------------------
// Mutants of the fixes for forum t/11458 n° 9 and review bsblan-032-r3 (m1, m2).
// Each one breaks one fix; the whole suite must fail, never hang. Run one at a
// time in a private copy of the repository (never the working tree), under a
// RAM cap and a deadline that kills the whole process group:
//
//   node scripts/mutants.mjs [names...]
//   MUTANTS_REPO=<another clone> node scripts/mutants.mjs   (default: this repository)
//
// The unmodified suite runs first in the copy: red, the run stops ("baseline
// FAILED", exit 1) and no mutant is judged (review bsblan-033-r1 I1).
//
// Needs `memcap`, `setsid` and `timeout` (the dev VM). Not in the image.
// -----------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(
  process.env.MUTANTS_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
);
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
    '      if (this.failing !== err.message) {\n        this.failing = err.message;',
    '      if (true) {\n        this.failing = err.message;',
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
    '      if (this.failing) {\n        this.failing = this.failing;',
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
  // Review bsblan-033-r1 m2 (its R7-R9): every twin pinned.
  ['T5-no-hc2-twin', 'src/app.js', '  [F.HC2_MODE]: [F.HC2_MODE_STATE],\n', ''],
  ['T6-no-dhw-twin', 'src/app.js', '  [F.DHW_MODE_SELECT]: [F.DHW_MODE],\n', ''],
  [
    'T7-no-legacy-712-twin',
    'src/app.js',
    '  [F.HEATING_REDUCED_TARGET]: [F.HEATING_SETPOINT_REDUCED],\n',
    '',
  ],
  [
    'T8-no-legacy-1612-twin',
    'src/app.js',
    '  [F.DHW_REDUCED_TARGET]: [F.DHW_SETPOINT_REDUCED],\n',
    '',
  ],
  // Review bsblan-033-r1 m1 (its R1, R2, R4): protective paths stay warnings.
  [
    'W1-drop-by-protective-as-replaced',
    'src/app.js',
    '    for (const entry of this.waiting.values()) {\n      entry.reject(this.refusal(text));',
    '    for (const entry of this.waiting.values()) {\n      entry.reject(Object.assign(this.refusal(text), { notice: NOTICES.replaced }));',
  ],
  [
    'W2-protective-queued-as-debug',
    'src/app.js',
    '      const queued = this.refusal(ERRORS.protectiveQueued);\n      queued.pending = true;',
    "      const queued = this.refusal(ERRORS.protectiveQueued);\n      queued.pending = true;\n      queued.notice = 'queued';",
  ],
  [
    'W3-protective-late-outcome-info',
    'src/app.js',
    '        this.logger.warn(`BSB-LAN ${role} ${wanted.value} (queued): ${err.message}`);',
    '        this.logger.info(`BSB-LAN ${role} ${wanted.value} (queued): ${err.message}`);',
  ],
  // Review bsblan-033-r1 m3: a new cause during the same outage is logged.
  [
    'P6-new-cause-hidden',
    'src/publisher.js',
    '      if (this.failing !== err.message) {',
    '      if (!this.failing) {',
  ],
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

/** The whole suite in `cwd`, its process group killed at the deadline. */
function suite(cwd) {
  const started = Date.now();
  const run = spawnSync(
    'setsid',
    ['memcap', '-m', '3G', 'timeout', '-k', '5', '300', 'node', '--test', '--test-timeout=60000'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const out = `${run.stdout}${run.stderr}`;
  return {
    status: run.status,
    failed: /ℹ fail (\d+)/.exec(out)?.[1],
    hung: run.status === 124 || run.status === 137,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// A private copy (node_modules copied, never linked), removed at the end.
// Only `.git` itself is left out (`.github` holds the release script a test imports).
const git = join(repo, '.git');
const work = mkdtempSync(join(tmpdir(), 'bsblan-mutants-'));
let survivors = 0;
try {
  const copy = join(work, 'repo');
  cpSync(repo, copy, {
    recursive: true,
    filter: (src) => src !== git && !src.startsWith(`${git}${sep}`),
  });
  const base = suite(copy);
  console.log(`baseline: exit ${base.status}, fail ${base.failed}, ${base.seconds} s`);
  if (base.status !== 0 || base.failed !== '0') {
    console.log('baseline FAILED: the unmodified suite is red, no mutant judged');
    survivors = Infinity;
  }
  for (const [name, file, from, to] of survivors === 0 ? MUTANTS : []) {
    if (only.length > 0 && !only.includes(name)) {
      continue;
    }
    const path = join(copy, file);
    const original = readFileSync(path, 'utf8');
    let line;
    try {
      apply(path, from, to);
      const run = suite(copy);
      const killed = !run.hung && run.failed !== undefined && run.failed !== '0';
      if (!killed) {
        survivors += 1;
      }
      const verdict = run.hung ? `HUNG(${run.status})` : killed ? 'KILLED' : 'SURVIVED';
      line = `${name}: ${verdict} (fail ${run.failed}, ${run.seconds} s)`;
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
