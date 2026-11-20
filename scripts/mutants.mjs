// -----------------------------------------------------------------------------
// Mutants of the fixes for forum t/11458 n° 9 and n° 11 (0.3.4), n° 13 (0.4.0), n° 15 (0.4.1),
// n° 17 (X1-X11), review bsblan-032-r3 (m1, m2).
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
  ['L2-queued-no-notice', 'src/app.js', '      err.notice = notice;\n', ''],
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
    '          logOutcome(this.logger, what, err, what);',
    '          this.logger.warn(`${what}: ${err.message}`);',
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
    '    if (this.causes.has(cause)) {\n      return;\n    }\n',
    '',
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
    '        this.failing = false;\n        this.causes.clear();',
    '        this.causes.clear();',
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
    '    if (this.causes.size < MAX_CAUSES) {',
    '    if (this.causes.size < 1) {',
  ],
  // Review bsblan-033-r2 J1: the bound, its reset, the outage flag, digits ignored.
  ['J1-no-cap', 'src/publisher.js', '    if (this.causes.size < MAX_CAUSES) {', '    if (true) {'],
  ['J2-causes-never-cleared', 'src/publisher.js', '        this.causes.clear();\n', ''],
  ['J3-capped-never-reset', 'src/publisher.js', '        this.capped = false;\n', ''],
  [
    'J4-outage-flag-is-the-cause',
    'src/publisher.js',
    '    this.failing = true;\n',
    "    this.failing = String(err?.message ?? '');\n",
  ],
  ['J5-digits-compared', 'src/publisher.js', "message.replace(/\\d+/g, '#')", 'message'],
  [
    'J6-no-further-causes-line',
    'src/publisher.js',
    '    if (!this.capped) {\n      this.capped = true;',
    '    if (false) {\n      this.capped = true;',
  ],
  // 0.3.4 (XDECO t/11458 n° 11): budgets from getting the adapter, "going on",
  // a command's own try during a backoff, a Protection freed between requests.
  [
    'B1-read-budget-2.5s',
    'src/constants.js',
    'commandReadMax: 12 * SECOND,',
    'commandReadMax: 2_500,',
  ],
  [
    'B2-read-budget-from-click',
    'src/app.js',
    'readBy: start + TIMINGS.commandReadMax,',
    'readBy: received + TIMINGS.commandReadMax,',
  ],
  [
    'B3-start-wait-2.2s',
    'src/app.js',
    '{ startBy: Math.min(received + TIMINGS.commandStartWait, startLimit) }',
    '{ startBy: Math.min(received + 2_200, startLimit) }',
  ],
  ['B4-confirm-from-click-only', 'src/app.js', 'this.now() + TIMINGS.commandConfirmMax,', '0,'],
  [
    'B5-refused-during-backoff',
    'src/app.js',
    'if (generation !== this.generation || !this.commandable || mac !== this.adapter.mac) {',
    'if (generation !== this.generation || !this.live || mac !== this.adapter.mac) {',
  ],
  [
    'B6-tries-after-no-mac',
    'src/app.js',
    "const HELD = new Set(['noMac', ",
    'const HELD = new Set([',
  ],
  [
    'B7-no-yield-after-ji',
    'src/app.js',
    '      // A protective command or a newer value meanwhile: the adapter is freed now.\n      this.checkBeforeSend(generation, target, wanted, epoch, arrival);\n',
    '',
  ],
  [
    'B8-read-back-before-protection',
    'src/app.js',
    'if (!protective && epoch !== this.stopEpoch) {',
    'if (false) {',
  ],
  [
    'B9-going-on-as-warning',
    'src/notices.js',
    '    logger?.info(`${what} ${LINES[NOTICES.goingOn]}`);',
    '    logger?.warn(`${what} ${LINES[NOTICES.goingOn]}`);',
  ],
  ['B10-no-ack-margin', 'src/app.js', 'received + TIMINGS.commandAckMargin,', 'received,'],
  // Review bsblan-034-r1.
  [
    'C1-never-replaced',
    'src/app.js',
    '    if ((this.latest.get(`${mac}:${role}`) ?? 0) > arrival) {',
    '    if (false) {',
  ],
  [
    'C2-latest-not-set',
    'src/app.js',
    '    this.latest.set(`${target.mac}:${target.role}`, arrival);\n',
    '',
  ],
  ['C3-no-offline-show', 'src/app.js', '    this.showOffline(target, id);\n', ''],
  ['C4-offline-fresh-not-kept', 'src/app.js', '        this.offlineFresh.set(id, seq);\n', ''],
  [
    'C5-slow-hint-on-retry',
    'src/app.js',
    'throw this.refusal(retry ? text : slowOr(text, err));',
    'throw this.refusal(slowOr(text, err));',
  ],
  [
    'C6-no-own-try-spacing',
    'src/app.js',
    '        this.ownTryUntil = this.now() + TIMINGS.ownTryRetry;\n',
    '',
  ],
  [
    'C7-own-try-full-budget',
    'src/app.js',
    'answerBy: retry ? Math.min(readBy, this.now() + TIMINGS.ownTryInfo) : readBy,',
    'answerBy: readBy,',
  ],
  [
    'C8-no-check-at-session-start',
    'src/app.js',
    '    // it waited for the adapter: nothing requested (r034 m5).\n    this.checkBeforeSend(generation, target, wanted, epoch, arrival);\n',
    '    // it waited for the adapter: nothing requested (r034 m5).\n',
  ],
  [
    'C9-queued-no-start-limit',
    'src/app.js',
    'Math.min(received + TIMINGS.commandStartWait, startLimit)',
    'received + TIMINGS.commandStartWait',
  ],
  [
    'C10-retry-said-slow',
    'src/app.js',
    'error: retry ? ERRORS.goingOnRetry : ERRORS.goingOn,',
    'error: ERRORS.goingOn,',
  ],
  [
    'C11-start-wait-60s',
    'src/app.js',
    'Math.min(received + TIMINGS.commandStartWait, startLimit)',
    'Math.min(received + 60_000, startLimit)',
  ],
  [
    'C12-send-by-plus-30s',
    'src/app.js',
    'sendBy: start + TIMINGS.commandReadMax + TIMINGS.commandMinSend,',
    'sendBy: start + TIMINGS.commandReadMax + 30_000,',
  ],
  // Review bsblan-034-r2.
  [
    'D1-replaced-not-checked-at-connect',
    'src/app.js',
    'beforeSend: () => this.checkBeforeSend(generation, target, wanted, epoch, arrival),',
    'beforeSend: () => this.checkBeforeSend(generation, target, wanted, epoch, Infinity),',
  ],
  [
    'D2-hold-also-online',
    'src/app.js',
    'if (!this.live && this.ownTryUntil > this.now()) {',
    'if (this.ownTryUntil > this.now()) {',
  ],
  [
    'D3-fresh-kept-after-good-read',
    'src/app.js',
    '    adapter.online = true;\n    this.offlineFresh.clear();\n',
    '    adapter.online = true;\n',
  ],
  [
    'D4-fresh-kept-after-failed-read',
    'src/app.js',
    "    // A command's read made before this failed read is not current any more (r034-r2 J1).\n    this.offlineFresh.clear();\n",
    '',
  ],
  [
    'D5-fresh-kept-after-failed-own-try',
    'src/app.js',
    '        this.ownTryUntil = this.now() + TIMINGS.ownTryRetry;\n        this.offlineFresh.clear();\n',
    '        this.ownTryUntil = this.now() + TIMINGS.ownTryRetry;\n',
  ],
  [
    'D6-fresh-kept-in-a-halt',
    'src/app.js',
    '    adapter.online = false;\n    this.offlineFresh.clear();\n',
    '    adapter.online = false;\n',
  ],
  // t/11458 n° 13 (0.4.0): the bounds named, the value asked, the widget.
  [
    'N1-comfort-not-above-reduced',
    'src/app.js',
    "        ...(spec.reduced ? [] : [bound('reduced')]),\n",
    '',
  ],
  [
    'N2-reduced-not-below-comfort',
    'src/app.js',
    "        ...(spec.reduced ? [bound('comfort')] : []),\n",
    '',
  ],
  [
    'N3-tie-takes-the-last',
    'src/app.js',
    '(better(bound.value, best.value) ? bound : best)',
    '(better(bound.value, best.value) || bound.value === best.value ? bound : best)',
  ],
  [
    'N4-no-range-of-the-last-read',
    'src/app.js',
    '      return ERRORS.outOfDeviceRange(number, range.low, range.high, { lastRead: true });',
    '      return ERRORS.outOfRange(number, min, max);',
  ],
  [
    'N5-range-of-another-adapter',
    'src/app.js',
    '    const values = mac && this.adapter?.mac === mac ? this.adapter.values : undefined;',
    '    const values = this.adapter?.values;',
  ],
  [
    'N6-empty-range-not-named',
    'src/app.js',
    '    if (low.value > high.value) {\n      // The bounds read',
    '    if (false) {\n      // The bounds read',
  ],
  [
    'N7-missing-bound-not-named',
    'src/app.js',
    '      throw this.refusal(ERRORS.missingBounds(wanted.value, range.missing));',
    '      throw this.refusal(ERRORS.missingValue);',
  ],
  [
    'N8-mode-of-circuit-2-not-named',
    'src/app.js',
    '    if (ids.mode && values?.[ids.modeKey] === undefined) {',
    '    if (false) {',
  ],
  ['N9-no-value-in-the-log', 'src/handlers.js', ' ${shownValue(value)}`', '`'],
  [
    'N10-invalid-input-logged',
    'src/notices.js',
    "  return '(invalid value)';",
    '  return String(value);',
  ],
  [
    'N11-no-value-in-step-refusal',
    'src/app.js',
    'ERRORS.badStep(0.1, number)',
    'ERRORS.badStep(0.1, 0)',
  ],
  ['N12-widget-shows-old-values', 'src/widget.js', '  if (!live || !values) {', '  if (!values) {'],
  [
    'N13-widget-nudged-on-every-publish',
    'src/app.js',
    '    if (!this.widgetOwed && json === this.widgetShown) {\n      return;\n    }\n',
    '',
  ],
  [
    'N14-widget-nudged-before-asked',
    'src/app.js',
    '    if (!this.widgetAsked || this.stopped) {',
    '    if (this.stopped) {',
  ],
  // Review bsblan-040-r1: the nudges spaced as Gladys requires, the TTL, m1, M16, M21.
  [
    'N15-no-spacing',
    'src/app.js',
    '    if (since >= 0 && since < TIMINGS.widgetSpacing) {',
    '    if (false) {',
  ],
  [
    'N16-no-nudge-on-reconnection',
    'src/app.js',
    '    this.nudgeWidget({ force: true });\n    if (this.configTimer',
    '    if (this.configTimer',
  ],
  [
    'N17-timer-kept-after-stop',
    'src/app.js',
    '      this.timers.clearTimeout(this.widgetTimer);\n      this.widgetTimer = undefined;\n',
    '',
  ],
  [
    'N18-ttl-not-capped',
    'src/widget.js',
    'const TTL = { min: 10, max: 60 };',
    'const TTL = { min: 10, max: 3600 };',
  ],
  [
    'N19-pause-as-unreachable',
    'src/app.js',
    '      reason: held ? word(this.status()[1], language) : undefined,',
    '      reason: undefined,',
  ],
  [
    'N20-empty-range-as-last-read',
    'src/app.js',
    'if (range?.low && range.low.value <= range.high.value) {',
    'if (range?.low) {',
  ],
  [
    'N21-nudge-after-stop',
    'src/app.js',
    '    if (!this.widgetAsked || this.stopped) {',
    '    if (!this.widgetAsked) {',
  ],
  [
    'N22-deferred-nudge-never-sent',
    'src/app.js',
    '        this.widgetTimer = undefined;\n        this.nudgeWidget();\n',
    '        this.widgetTimer = undefined;\n',
  ],
  // Review bsblan-040-r2: one widget timer at most (X8), a pull never cancels a waiting nudge (n1).
  [
    'N23-second-timer',
    'src/app.js',
    '    if (this.widgetTimer !== undefined) {\n      // The nudge at the end',
    '    if (false) {\n      // The nudge at the end',
  ],
  [
    'N24-pull-cancels-the-nudge',
    'src/app.js',
    '      this.widgetOwed = true;\n    }\n    return content;',
    '    }\n    return content;',
  ],
  // t/11458 n° 15 (0.4.1): the extra parameters without a feature are said.
  [
    'N25-no-update-note',
    'src/app.js',
    '      if (missing.length > 0) {\n        notes.push(T.notes.extraNotInDevice(missing));',
    '      if (false) {\n        notes.push(T.notes.extraNotInDevice(missing));',
  ],
  ['N26-no-no-value-note', 'src/app.js', '    if (noValue.length > 0) {', '    if (false) {'],
  ['N27-error-said-inactive', 'src/params.js', "    return 'error';", "    return 'inactive';"],
  // t/11458 n° 17: a setpoint at "---" with its type is an empty feature, never 0.
  [
    'X1-pending-never-reported',
    'src/devices.js',
    '  for (const role of pendingRoles(values)) {\n    roles.add(role);\n  }\n',
    '',
  ],
  [
    'X2-pending-published-as-zero',
    'src/devices.js',
    '  for (const [role, valueOf] of Object.entries(NUMBERS)) {\n    const value = valueOf(values);\n    if (value !== undefined && Number.isFinite(value)) {',
    '  for (const [role, valueOf] of Object.entries(NUMBERS)) {\n    const value = valueOf(values) ?? (valueOf(values.pending ?? {}) === true ? 0 : undefined);\n    if (value !== undefined && Number.isFinite(value)) {',
  ],
  [
    'X3-any-temperature-pending',
    'src/params.js',
    '      PENDING.has(key) &&\n      pendingTemperature(entry) &&',
    '      pendingTemperature(entry) &&',
  ],
  [
    'X4-dhw-pending-without-its-mode',
    'src/params.js',
    '      (!DHW_KEYS.has(key) || values.dhwMode !== undefined)',
    '      true',
  ],
  [
    'X5-type-guessed-from-dataType-0',
    'src/params.js',
    "  const vals = family === 'VALS' || typeName === 'TEMP';",
    "  const vals = field(entry, 'dataType') === 0 || family === 'VALS' || typeName === 'TEMP';",
  ],
  [
    'X6-fahrenheit-pending',
    'src/params.js',
    "  if (FAHRENHEIT.has(unit)) {\n    return undefined;\n  }\n  const name = cleanText(String(field(entry, 'name') ?? ''))?.slice(0, 60);\n  const family",
    "  const name = cleanText(String(field(entry, 'name') ?? ''))?.slice(0, 60);\n  const family",
  ],
  [
    'X7-error-is-no-value',
    'src/params.js',
    "  if (error !== undefined && error !== 0 && error !== '0') {\n    return false;\n  }\n  const value = field(entry, 'value');\n  if (value === null || value === undefined) {\n    return true;",
    "  const value = field(entry, 'value');\n  if (value === null || value === undefined) {\n    return true;",
  ],
  [
    'X8-no-update-note-for-pending',
    'src/app.js',
    '      if (pending.length > 0) {\n        notes.push(T.notes.pendingNotInDevice(pending));',
    '      if (false) {\n        notes.push(T.notes.pendingNotInDevice(pending));',
  ],
  [
    'X9-extra-pending-kind-forgotten',
    'src/app.js',
    '    this.rememberExtras(info.mac, { ...values.extraPending, ...values.extra });',
    '    this.rememberExtras(info.mac, values.extra);',
  ],
  [
    'X10-extra-inactive-said-without-feature',
    'src/app.js',
    "          why === 'pending' || (why === 'inactive' && has.has(ids.feature(extraRole(id)))),",
    "          why === 'pending',",
  ],
  [
    'X11-built-in-pending-with-untyped-answer',
    'src/params.js',
    "  const vals =\n    field(entry, 'dataType_family') === 'VALS' || field(entry, 'dataType_name') === 'TEMP';\n  return vals && CELSIUS.has(unit);",
    '  return CELSIUS.has(unit);',
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
