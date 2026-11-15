// -----------------------------------------------------------------------------
// Forum t/11458 n° 13 (XDECO, 0.3.4), 0.4.0: every setpoint refusal gives the
// value asked and where each bound comes from (parameter and name); a value
// out of the limits of the integration (5-35 °C) names the range of the
// controller at the last read when known; contradictory bounds (1012 above
// 1016) and a missing bound are named, not "no range"; the range is read
// again by every command (nothing kept); never another value than the one
// asked; the read-only dashboard widget. SDK fake Gladys, fake BSB-LAN,
// mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp, rangeOf } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { shownValue } from '../src/notices.js';
import { memoryStore } from '../src/store.js';
import { WIDGET_KEY, widgetContent } from '../src/widget.js';
import {
  HOST,
  MAC_ID,
  NOW,
  bsbParams,
  fakeBsbLan,
  fullParams,
  inactive,
  settle,
} from './fixtures/fakeBsbLan.js';

const ALLOWED = { address: HOST, allow_commands: true };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

const recorder = (lines) => {
  const at =
    (level) =>
    (...args) =>
      lines.push([level, args.map(String).join(' ')]);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

async function setup(t, { bsb = fakeBsbLan({ params: fullParams() }), config = ALLOWED } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const lines = [];
  const logger = recorder(lines);
  const gladys = createFakeGladys({ config });
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app, logger);
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
  /** A command, answered (waits 5 s after it so that the next one runs on its own). */
  const command = async (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device);
    const target = d.features.find((f) => f.external_id === feature(role));
    const box = {};
    gladys.fake.setValue(d, target, value).then((a) => (box.ack = a));
    for (let i = 0; i < 100 && !box.ack; i += 1) {
      await advance(100);
    }
    assert.ok(box.ack, 'answered');
    await advance(5 * SECOND);
    return box.ack;
  };
  return { gladys, app, bsb, advance, command, lines };
}

const writes = (bsb) => bsb.writes();
const temp = (bsb, id, value) => {
  bsb.params[id] = { ...bsb.params[id], value };
};

// --- 1. Where the bounds come from ------------------------------------------------------

test('n° 13: circuit 2, the comfort setpoint names 1012 and 1016 (the message XDECO asked for)', async (t) => {
  const s = await setup(t);
  temp(s.bsb, '1012', '17.0');
  temp(s.bsb, '1016', '25.0');
  const ack = await s.command('hc2-setpoint', 28.5);
  assert.equal(
    ack.error,
    "Consigne de 28,5 °C refusée : le régulateur l'accepte entre 17 °C (consigne réduite, 1012) et 25 °C (confort maximum, 1016) ; non envoyée.",
  );
  assert.match(
    (await s.command('hc2-setpoint', 16.5)).error,
    /^Consigne de 16,5 °C refusée : .* entre 17 °C \(consigne réduite, 1012\) et 25 °C/,
  );
  assert.deepEqual(writes(s.bsb), [], 'nothing written: never the nearest bound instead');
});

test('n° 13: circuit 2, the reduced setpoint names 1014 and 1010', async (t) => {
  const s = await setup(t);
  // 1010 21, 1014 8, 1016 26 (fullParams).
  const above = await s.command('hc2-reduced-target', 21.5);
  assert.match(
    above.error,
    /^Consigne de 21,5 °C refusée : le régulateur l'accepte entre 8 °C \(consigne hors-gel, 1014\) et 21 °C \(consigne de confort, 1010\) ; non envoyée\.$/,
  );
  assert.match((await s.command('hc2-reduced-target', 7.5)).error, /consigne hors-gel, 1014/);
  // A comfort max below the comfort setpoint bounds the reduced one too.
  temp(s.bsb, '1016', '20.0');
  assert.match(
    (await s.command('hc2-reduced-target', 20.5)).error,
    /et 20 °C \(confort maximum, 1016\)/,
  );
  assert.deepEqual(writes(s.bsb), []);
});

test('n° 13: circuit 1 names 710, 712, 714 and 716; in English too', async (t) => {
  const s = await setup(t, {
    bsb: fakeBsbLan({ params: bsbParams() }),
    config: { ...ALLOWED, language: 'en' },
  });
  // 710 20, 712 17, 714 10, 716 28.
  assert.equal(
    (await s.command('heating-setpoint', 28.5)).error,
    'Setpoint of 28.5 °C refused: the controller accepts it between 17 °C (reduced setpoint, 712) and 28 °C (comfort maximum, 716); not sent.',
  );
  assert.match(
    (await s.command('heating-reduced-target', 9.5)).error,
    /between 10 °C \(frost protection setpoint, 714\) and 20 °C \(comfort setpoint, 710\)/,
  );
  // 714 above 712: the frost protection one bounds the comfort setpoint.
  temp(s.bsb, '714', '18.0');
  assert.match(
    (await s.command('heating-setpoint', 17.5)).error,
    /between 18 °C \(frost protection setpoint, 714\)/,
  );
  assert.deepEqual(writes(s.bsb), []);
});

test('n° 13: hot water names 1612, 1614, 1610 and the ceiling', async (t) => {
  const s = await setup(t, { config: { ...ALLOWED, dhw_max_temperature: 55 } });
  // 1610 50, 1612 40, 1614 65.
  assert.match(
    (await s.command('dhw-setpoint', 39)).error,
    /entre 40 °C \(consigne réduite de l'eau chaude, 1612\) et 55 °C \(plafond de l'eau chaude\)/,
  );
  temp(s.bsb, '1614', '52.0');
  assert.match(
    (await s.command('dhw-setpoint', 53)).error,
    /^Consigne de 53 °C refusée : .* et 52 °C \(consigne d'eau chaude maximum, 1614\)/,
  );
  assert.match(
    (await s.command('dhw-reduced-target', 51)).error,
    /entre 10 °C \(limite du module\) et 50 °C \(consigne d'eau chaude, 1610\)/,
  );
  assert.match((await s.command('dhw-setpoint', 56)).error, /^Consigne de 56 °C refusée : .*55 °C/);
  assert.deepEqual(writes(s.bsb), []);
});

// --- 2. The 5-35 °C refusals ------------------------------------------------------------

test('n° 13: a value out of 5-35 °C gives the value asked and the range of the last read', async (t) => {
  const s = await setup(t);
  temp(s.bsb, '1012', '17.0');
  temp(s.bsb, '1016', '25.0');
  // The last read (the periodic one) gives 1012 17 and 1016 25.
  await s.advance(31 * SECOND);
  const before = s.bsb.reads().length;
  const ack = await s.command('hc2-setpoint', 2);
  assert.equal(
    ack.error,
    "Consigne de 2 °C refusée : le régulateur l'accepte entre 17 °C (consigne réduite, 1012) et 25 °C (confort maximum, 1016) d'après la dernière lecture ; non envoyée.",
  );
  assert.ok(
    !s.bsb
      .reads()
      .slice(before)
      .some((r) => r.ids.join() === '1000,1010,1012,1014,1016'),
    'refused on arrival: no read of its own',
  );
  assert.match((await s.command('hc2-setpoint', 225)).error, /^Consigne de 225 °C refusée/);
  assert.match((await s.command('hc2-setpoint', '2')).error, /^Consigne de 2 °C refusée/);
  // The log line names the value too, as a warning.
  const logged = s.lines.filter(([, l]) => l.includes('hc2-setpoint'));
  assert.ok(
    logged.some(([level, l]) => level === 'warn' && /:hc2-setpoint 225 refused: /.test(l)),
    JSON.stringify(logged),
  );
  assert.deepEqual(writes(s.bsb), []);
});

test('n° 13: without any read, the limits of the integration (5-35 °C), with the value', () => {
  const app = new BsbLanApp({
    gladys: createFakeGladys({ config: ALLOWED }),
    store: memoryStore(),
  });
  assert.throws(() => app.parseCommand('hc2-setpoint', 36, MAC_ID), {
    message:
      'Consigne de 36 °C refusée : elle doit être comprise entre 5 et 35 °C (limites du module) ; non envoyée.',
  });
  assert.throws(
    () => app.parseCommand('dhw-setpoint', 9, MAC_ID),
    /^Error: Consigne de 9 °C .* entre 10 et 65 °C/,
  );
  assert.throws(
    () => app.parseCommand('hc2-setpoint', 21.25, MAC_ID),
    /^Error: Consigne de 21,25 °C refusée : elle doit être un multiple de 0,1 °C/,
  );
});

test('n° 13: the range of the last read of another adapter is never shown', async (t) => {
  const s = await setup(t);
  assert.throws(
    () => s.app.parseCommand('hc2-setpoint', 2, '0123456789ab'),
    /entre 5 et 35 °C \(limites du module\)/,
  );
  assert.throws(() => s.app.parseCommand('hc2-setpoint', 2, MAC_ID), /d'après la dernière lecture/);
});

test('n° 13: the log shows a valid value, never an invalid input', async (t) => {
  assert.equal(shownValue(22.5), '22.5');
  assert.equal(shownValue('22.5'), '22.5');
  assert.equal(shownValue('comfort'), 'comfort');
  assert.equal(shownValue('a b\nc'), '(invalid value)');
  assert.equal(shownValue(Number.NaN), '(invalid value)');
  assert.equal(shownValue(null), '(invalid value)');
  assert.equal(shownValue('x'.repeat(40)), '(invalid value)');
  const s = await setup(t);
  await s.command('hc2-setpoint', 'abc\r\nsecret');
  const logged = s.lines.filter(([, l]) => l.includes('hc2-setpoint'));
  assert.ok(logged.some(([, l]) => l.includes('hc2-setpoint (invalid value) refused')));
  assert.ok(!logged.some(([, l]) => l.includes('secret')));
});

// --- 3. Contradictory or missing bounds, read again by every command --------------------

test('n° 13: 1012 above 1016 is named (no comfort setpoint fits), not "no range"', async (t) => {
  const s = await setup(t);
  temp(s.bsb, '1012', '22.0');
  temp(s.bsb, '1016', '21.0');
  const ack = await s.command('hc2-setpoint', 20);
  assert.equal(
    ack.error,
    'Consigne de 20 °C refusée : aucune valeur ne convient, la borne basse 22 °C (consigne réduite, 1012) dépasse la borne haute 21 °C (confort maximum, 1016) ; corrigez ces réglages sur le régulateur. Non envoyée.',
  );
  // Fixed on the controller: the very next command reads the range again and goes.
  temp(s.bsb, '1016', '26.0');
  assert.equal((await s.command('hc2-setpoint', 23)).success, true);
  assert.deepEqual(writes(s.bsb), [['1010', '23.0']]);
});

test('n° 13: a missing bound is named; the next command reads it again at once', async (t) => {
  const s = await setup(t);
  s.bsb.params['1016'] = inactive('Comfort setpoint max HC2');
  const ack = await s.command('hc2-setpoint', 22);
  assert.equal(
    ack.error,
    "Consigne de 22 °C non envoyée : BSB-LAN n'a pas donné la valeur actuelle de 1016 (confort maximum), nécessaire pour connaître la plage permise.",
  );
  s.bsb.params['1016'] = { ...fullParams()['1016'], value: '26.0' };
  const reads = s.bsb.reads().length;
  assert.equal((await s.command('hc2-setpoint', 22)).success, true, 'no wait: read again now');
  assert.ok(
    s.bsb
      .reads()
      .slice(reads)
      .some((r) => r.ids.includes('1016')),
    'its own read of the range',
  );
  // Circuit 2 without its mode: 1000 is named.
  s.bsb.params['1000'] = inactive('Operating mode HC2');
  assert.match((await s.command('hc2-setpoint', 21)).error, /de 1000 \(mode du circuit\)/);
  assert.deepEqual(writes(s.bsb), [['1010', '22.0']]);
});

test('n° 13: rangeOf picks the tightest bound, the parameter on a tie', () => {
  const spec = {
    kind: 'heating',
    bounds: ['c', 'r', 'p', 'm'],
    params: { comfort: '1010', reduced: '1012', protective: '1014', comfortMax: '1016' },
  };
  const range = rangeOf(spec, { c: 21, r: 8, p: 8, m: 35 }, 65);
  assert.deepEqual(range.low, { value: 8, source: 'reduced', id: '1012' });
  assert.deepEqual(range.high, { value: 35, source: 'comfortMax', id: '1016' });
  assert.deepEqual(rangeOf(spec, { c: 21, r: 3, p: 2, m: 40 }, 65).low, {
    value: 5,
    source: 'module',
  });
  assert.deepEqual(rangeOf(spec, { c: 21, r: 3, p: 2, m: 40 }, 65).high, {
    value: 35,
    source: 'module',
  });
  assert.deepEqual(rangeOf({ ...spec, reduced: true }, { c: 21, r: 17, p: 8, m: 25 }, 65).high, {
    value: 21,
    source: 'comfort',
    id: '1010',
  });
  assert.deepEqual(rangeOf(spec, { c: 21, p: 8 }, 65).missing, [
    { id: '1012', source: 'reduced' },
    { id: '1016', source: 'comfortMax' },
  ]);
  const dhw = { kind: 'dhw' };
  const values = { dhwSetpoint: 50, dhwSetpointReduced: 40, dhwMax: 65 };
  assert.deepEqual(rangeOf(dhw, values, 65).high, { value: 65, source: 'dhwMax', id: '1614' });
  assert.deepEqual(rangeOf(dhw, values, 55).high, { value: 55, source: 'ceiling' });
});

// --- 6. The dashboard widget ------------------------------------------------------------

test('n° 13: the widget shows both circuits and the hot water, valid, read only, fr and en', async (t) => {
  const s = await setup(t);
  const fr = await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  assert.equal(fr.success, true, fr.error);
  const content = fr.data.content ?? fr.data;
  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(!content.components.some((c) => c.type === 'button'), 'no button');
  const tiles = content.components.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((c) => [c.label, c.value]),
    [
      ['Ambiance circuit 1', 19.3],
      ['Ambiance circuit 2', 20.6],
      ['Eau chaude', 48.5],
      ['Extérieur', 7.6],
    ],
  );
  const [status] = content.components.filter((c) => c.type === 'status');
  const items = Object.fromEntries(status.items.map((i) => [i.label, i.value]));
  assert.equal(items['Circuit 1 · mode'], 'Confort');
  assert.equal(items['Circuit 1 · confort / réduite'], '20 °C / 17 °C');
  assert.equal(items['Circuit 1 · état'], 'Heating mode comfort');
  assert.equal(items['Circuit 2 · mode'], 'Automatique (programme horaire)');
  assert.equal(items['Circuit 2 · confort / réduite'], '21 °C / 18 °C');
  assert.equal(items['Circuit 2 · état'], 'Heating mode reduced');
  assert.equal(items['Eau chaude · mode'], 'Marche');
  assert.equal(items['Eau chaude · consigne / réduite'], '50 °C / 40 °C');
  assert.equal(items['Eau chaude · état'], 'Charging');
  const en = await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'en' });
  const enContent = en.data.content ?? en.data;
  assert.deepEqual(validateWidgetContent(enContent), []);
  const enItems = enContent.components.find((c) => c.type === 'status').items;
  assert.ok(enItems.some((i) => i.label === 'Circuit 2 · comfort / reduced'));
  assert.ok(enItems.some((i) => i.label === 'Hot water · status'));
});

test('n° 13: the widget never shows old values as current, and nudges only on a change', async (t) => {
  const s = await setup(t);
  await s.advance(31 * SECOND);
  assert.deepEqual(s.gladys.fake.widgetRefreshes, [], 'never asked: no nudge');
  await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  await s.advance(62 * SECOND);
  assert.deepEqual(s.gladys.fake.widgetRefreshes, [], 'nothing changed: no nudge');
  temp(s.bsb, '1010', '22.5');
  await s.advance(31 * SECOND);
  assert.deepEqual(s.gladys.fake.widgetRefreshes, [WIDGET_KEY], 'one nudge for the change');
  await s.advance(62 * SECOND);
  assert.deepEqual(s.gladys.fake.widgetRefreshes, [WIDGET_KEY]);
  // BSB-LAN stops answering: no value shown as current.
  s.bsb.down = true;
  await s.advance(40 * SECOND);
  assert.equal(s.gladys.fake.widgetRefreshes.length, 2, 'one nudge: unreachable');
  const ack = await s.gladys.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
  const content = ack.data.content ?? ack.data;
  assert.deepEqual(content.components, [
    { type: 'text', variant: 'body', text: 'BSB-LAN ne répond pas : aucune valeur actuelle.' },
  ]);
  assert.deepEqual(validateWidgetContent(content), []);
});

test('n° 13: the widget content fits the budget and the text lengths', () => {
  const long = 'x'.repeat(200);
  const values = {
    ...{ room: 19, room2: 20, dhw: 50, outdoor: 5 },
    mode: { code: 99, key: undefined },
    mode2: { code: 1, key: 'automatic' },
    heatingSetpoint: 20.04,
    status: { code: 114, desc: long },
    heating2SetpointReduced: 17,
    status2: { code: 116 },
    dhwMode: { code: 1, key: 'on' },
    dhwSetpoint: 50,
    dhwStatus: { code: 92, desc: long },
  };
  for (const language of ['fr', 'en']) {
    const content = widgetContent({ values, live: true, everRead: true, language, pollSeconds: 5 });
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(content.ttl_seconds, 10);
    const items = content.components.find((c) => c.type === 'status').items;
    assert.ok(items.length <= 10);
    assert.ok(items.every((i) => i.label.length <= 40 && String(i.value).length <= 40));
  }
  const fr = widgetContent({ values, live: true, everRead: true, language: 'fr', pollSeconds: 30 });
  const items = Object.fromEntries(
    fr.components.find((c) => c.type === 'status').items.map((i) => [i.label, i.value]),
  );
  assert.equal(items['Circuit 1 · mode'], 'Mode inconnu (99)');
  assert.equal(items['Circuit 1 · confort / réduite'], '20 °C / —');
  assert.equal(items['Circuit 2 · état'], 'État 116');
  assert.equal(
    widgetContent({
      values: undefined,
      live: false,
      everRead: false,
      language: 'en',
      pollSeconds: 30,
    }).components[0].text,
    'BSB-LAN not read yet.',
  );
  assert.equal(
    widgetContent({ values, live: true, everRead: true, language: 'en', pollSeconds: 9000 })
      .ttl_seconds,
    3600,
  );
});
