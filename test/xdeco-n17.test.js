// -----------------------------------------------------------------------------
// Forum t/11458 n° 17 (XDECO, 0.4.1): configured while circuit 2 was in
// Protection (1000 = 0), 8774 "Resulting flow temperature setpoint HC2"
// answered `"value": "---"` (error 0, payload 010000): no feature, offered
// through "Update" only once the circuit heated again. Now a setpoint the
// controller gives as "---" with a plain-number type gets its feature at
// once, empty (never 0) until the first value; an extra parameter too when
// BSB-LAN prints its type (VALS). A measured temperature at "---" (a sensor
// not fitted), an answer without a type, in °F or in error: unchanged, no
// feature. SDK fake Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { deviceStates, pendingRoles, reportedRoles } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { decode, extraIssue, isInactive, pendingOf, pendingTemperature } from '../src/params.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  MAC_ID,
  NOW,
  disabled,
  fakeBsbLan,
  fullParams,
  inactive,
  settle,
} from './fixtures/fakeBsbLan.js';

const CONFIG = { address: HOST };
const device = `ext:test-integration:bsblan:${MAC_ID}`;
const feature = (role) => `${device}:${role}`;

/** XDECO's answers (t/11458 n° 17): 8774 at "---" in Protection, 47.8 once in Reduced. */
const flow2Disabled = () => disabled('Consigne de température de départ résultante CC2');
const flow2Value = () => ({ ...flow2Disabled(), value: '47.8', payload: '000BF2' });
const protection = () => ({ ...fullParams()[1000], value: '0', desc: 'Protection' });

async function setup(t, { params = fullParams(), config = CONFIG, logs = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const bsb = fakeBsbLan({ params });
  const gladys = createFakeGladys({ config });
  const log =
    (level) =>
    (...args) =>
      logs.push(`${level} ${args.map(String).join(' ')}`);
  const logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(100);
      await settle();
    }
  };
  const connecting = gladys.connect();
  await advance(3 * SECOND);
  await connecting;
  await advance(2 * SECOND);
  const create = async () => {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await advance(SECOND);
  };
  const status = () => gladys.fake.connectionStatus.message.fr;
  const roles = (d) => d.features.map((f) => f.external_id.split(':').pop());
  const discovered = () => gladys.fake.discoveredDevices.find((d) => d.external_id === device);
  const created = () => gladys.fake.devices.find((d) => d.external_id === device);
  const statesOf = (role) =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === feature(role));
  const command = async (role, value) => {
    const d = created();
    const target = d.features.find((f) => f.external_id === feature(role));
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(5 * SECOND);
    return ack;
  };
  return {
    gladys,
    app,
    bsb,
    advance,
    create,
    status,
    roles,
    discovered,
    created,
    statesOf,
    command,
  };
}

test("n° 17: isInactive, pendingOf, pendingTemperature on XDECO's answer and its variants", () => {
  const d = flow2Disabled();
  assert.equal(isInactive(d), true);
  assert.equal(isInactive(flow2Value()), false);
  assert.equal(isInactive({ ...d, error: 7 }), false, 'an error is not "no value"');
  assert.equal(isInactive({ ...d, error: '258' }), false);
  assert.equal(isInactive({ ...d, value: null }), true);
  assert.equal(isInactive({ ...d, value: '' }), true);
  assert.equal(isInactive({ ...d, value: 'None' }), true, 'replaceDisabled set for Home Assistant');
  assert.equal(isInactive(undefined), false);
  assert.deepEqual(pendingOf(d), {
    kind: 'temperature',
    name: 'Consigne de température de départ résultante CC2',
    unit: '°C',
  });
  assert.deepEqual(pendingOf({ ...d, unit: '&deg;C' }), { ...pendingOf(d), unit: '°C' });
  assert.equal(pendingOf({ ...d, unit: '°F' }), undefined, 'never a °F feature');
  assert.equal(pendingOf(disabled('Hot', '°F', 'TEMP_WORD')), undefined, 'not even as a number');
  assert.equal(pendingOf({ ...d, error: 7 }), undefined);
  assert.equal(pendingOf(flow2Value()), undefined, 'a value is not pending');
  assert.deepEqual(pendingOf(disabled('Heating curve slope', '', 'GRADIENT_SMALL')), {
    kind: 'number',
    name: 'Heating curve slope',
    unit: '',
  });
  assert.deepEqual(pendingOf(disabled('Modulation', '%', 'PERCENT')).kind, 'number');
  assert.equal(pendingOf(inactive('Untyped')), undefined, 'dataType 0 alone is no type');
  assert.equal(pendingOf({ ...inactive('Untyped'), unit: '°C' }), undefined, 'even in °C');
  assert.equal(
    pendingOf({ ...d, dataType_family: 'ENUM', dataType_name: 'ENUM', dataType: 1 }),
    undefined,
    'an enumeration is not guessed',
  );
  assert.equal(pendingTemperature(d), true);
  assert.equal(pendingTemperature({ ...d, unit: '' }), true, 'the role fixes °C');
  assert.equal(pendingTemperature({ ...d, unit: '°F' }), false);
  assert.equal(pendingTemperature({ ...d, error: 7 }), false);
  assert.equal(pendingTemperature(inactive('Untyped')), false);
  assert.equal(pendingTemperature(flow2Value()), false);
  assert.equal(extraIssue(d), 'pending');
  assert.equal(extraIssue(inactive('Untyped')), 'inactive');
});

test('n° 17: decode marks the setpoints at "---" pending, never a measured temperature nor a circuit not there', () => {
  const params = { ...fullParams(), 1000: protection(), 8774: flow2Disabled() };
  let v = decode('bsb', params);
  assert.equal(v.flowSetpoint2, undefined);
  assert.deepEqual(v.pending, { flowSetpoint2: true });
  assert.deepEqual(pendingRoles(v), ['hc2-flow-setpoint']);
  // Every setpoint of PENDING, the rest of its circuit there.
  v = decode('bsb', {
    ...fullParams(),
    710: disabled('Comfort setpoint'),
    712: disabled('Reduced setpoint'),
    8744: disabled('Flow setpoint H1'),
    1010: disabled('Comfort setpoint HC2'),
    1012: disabled('Reduced setpoint HC2'),
    8774: flow2Disabled(),
    1610: disabled('DHW nominal'),
    1612: disabled('DHW reduced'),
  });
  assert.deepEqual(Object.keys(v.pending).sort(), [
    'dhwSetpoint',
    'dhwSetpointReduced',
    'flowSetpoint',
    'flowSetpoint2',
    'heating2Setpoint',
    'heating2SetpointReduced',
    'heatingSetpoint',
    'heatingSetpointReduced',
  ]);
  assert.deepEqual(pendingRoles(v).sort(), [
    'dhw-reduced-target',
    'dhw-setpoint',
    'flow-setpoint',
    'hc2-flow-setpoint',
    'hc2-reduced-target',
    'hc2-setpoint',
    'heating-reduced-target',
    'heating-setpoint',
  ]);
  assert.ok(!pendingRoles(v).includes('heating-setpoint-reduced'), 'never a legacy probe');
  // Measured temperatures at "---": a sensor not fitted, no feature.
  v = decode('bsb', {
    ...fullParams(),
    8740: disabled('Room temperature'),
    8770: disabled('Room temperature 2'),
    8700: disabled('Outside temperature'),
    8743: disabled('Flow temperature'),
    8773: disabled('Flow temperature 2'),
    8830: disabled('DHW temperature'),
    8310: disabled('Boiler temperature'),
    714: disabled('Frost protection setpoint'),
    716: disabled('Comfort max'),
    1614: disabled('DHW max'),
  });
  assert.deepEqual(v.pending, {});
  // Circuit 2 without its mode: nothing of it; hot water without its mode: nothing of it.
  v = decode('bsb', { ...fullParams(), 1000: inactive('HC2'), 1010: disabled('Comfort HC2') });
  assert.deepEqual(v.pending, {});
  v = decode('bsb', { ...fullParams(), 1600: inactive('DHW'), 1610: disabled('DHW nominal') });
  assert.deepEqual(v.pending, {});
  // °F, an error, no type: nothing.
  for (const entry of [
    { ...flow2Disabled(), unit: '°F' },
    { ...flow2Disabled(), error: 7, value: '' },
    inactive('Flow setpoint 2'),
  ]) {
    v = decode('bsb', { ...fullParams(), 8774: entry });
    assert.deepEqual(v.pending, {}, JSON.stringify(entry));
  }
  // On PPS: nothing pending.
  v = decode('pps', { 15004: disabled('Room setpoint') });
  assert.deepEqual(v.pending, {});
});

test('n° 17: a pending role is reported, and deviceStates publishes nothing for it (never 0)', () => {
  const v = decode('bsb', { ...fullParams(), 1000: protection(), 8774: flow2Disabled() });
  const roles = reportedRoles(v, 'bsb');
  assert.ok(roles.has('hc2-flow-setpoint'));
  assert.ok(roles.has('hc2-temperature-flow'));
  const ids = { feature: (role) => feature(role) };
  const states = deviceStates(ids, v, { bus: 'bsb', language: 'fr' });
  assert.equal(
    states.find((s) => s.device_feature_external_id === feature('hc2-flow-setpoint')),
    undefined,
  );
  assert.ok(states.every((s) => s.state !== 0 || s.device_feature_external_id.includes('burner')));
  // Extra parameter at "---" with its type: reported, nothing published.
  const w = decode('bsb', { ...fullParams(), 1020: disabled('Slope', '', 'GRADIENT_SMALL') }, [
    '1020',
  ]);
  assert.deepEqual(w.extraPending, { 1020: { kind: 'number', name: 'Slope', unit: '' } });
  assert.deepEqual(w.extra, {});
  assert.ok(reportedRoles(w, 'bsb').has('param-1020'));
  assert.equal(
    deviceStates(ids, w, { bus: 'bsb', language: 'fr', extraKinds: { 1020: 'number' } }).find(
      (s) => s.device_feature_external_id === feature('param-1020'),
    ),
    undefined,
  );
});

test('n° 17: configured while circuit 2 is in Protection, the flow setpoint feature exists, empty, until 47.8', async (t) => {
  const params = { ...fullParams(), 1000: protection(), 8774: flow2Disabled() };
  const s = await setup(t, { params });
  const offered = s.discovered();
  assert.ok(s.roles(offered).includes('hc2-flow-setpoint'), 'offered at the configuration');
  const f = offered.features.find((x) => x.external_id === feature('hc2-flow-setpoint'));
  assert.equal(f.category, 'temperature-sensor');
  assert.equal(f.unit, 'celsius');
  assert.equal(f.min, 0);
  assert.equal(f.max, 120);
  await s.create();
  await s.advance(70 * SECOND);
  assert.deepEqual(s.statesOf('hc2-flow-setpoint'), [], 'no state while "---", never 0');
  assert.equal(s.gladys.fake.lastState(feature('hc2-flow-setpoint')), undefined);
  assert.doesNotMatch(s.status(), /Mettre à jour/);
  // Circuit 2 back in Reduced: 8774 gives 47.8, published; later "---" again: nothing new.
  s.bsb.params[1000] = fullParams()[1000];
  s.bsb.params[8774] = flow2Value();
  await s.advance(31 * SECOND);
  assert.equal(s.gladys.fake.lastState(feature('hc2-flow-setpoint')), 47.8);
  s.bsb.params[8774] = flow2Disabled();
  const count = s.statesOf('hc2-flow-setpoint').length;
  await s.advance(31 * SECOND);
  assert.equal(
    s.statesOf('hc2-flow-setpoint').length,
    count,
    'nothing published, Gladys keeps 47.8',
  );
  assert.ok(s.statesOf('hc2-flow-setpoint').every((x) => x.state !== 0));
});

test('n° 17: a device created before: the status says to click "Update", the ids never change', async (t) => {
  // Created when 8774 was unknown to the controller (error 7): no feature.
  const params = { ...fullParams(), 1000: protection(), 8774: { ...flow2Disabled(), error: 7 } };
  const s = await setup(t, { params });
  await s.create();
  assert.ok(!s.roles(s.created()).includes('hc2-flow-setpoint'));
  const before = s.roles(s.created());
  // Then "---" with its type.
  s.bsb.params[8774] = flow2Disabled();
  await s.advance(31 * SECOND);
  assert.ok(s.roles(s.discovered()).includes('hc2-flow-setpoint'), 'offered');
  assert.deepEqual(s.roles(s.created()), before, 'the created device is not touched by itself');
  assert.match(
    s.status(),
    /Consignes que BSB-LAN donne à « --- » pour l'instant, pas encore dans l'appareil créé : Consigne de départ \(circuit 2\)\. Ouvrez l'onglet Découverte/,
  );
  assert.match(
    s.gladys.fake.connectionStatus.message.en,
    /Setpoints BSB-LAN gives as "---" for now, not yet in the created device: Flow setpoint \(circuit 2\)\./,
  );
  // "Update": the feature is there, the note goes, the first value follows.
  await s.create();
  await s.advance(31 * SECOND);
  assert.ok(s.roles(s.created()).includes('hc2-flow-setpoint'));
  assert.doesNotMatch(s.status(), /pas encore dans l'appareil/);
  assert.deepEqual(s.statesOf('hc2-flow-setpoint'), []);
  s.bsb.params[8774] = flow2Value();
  await s.advance(31 * SECOND);
  assert.equal(s.gladys.fake.lastState(feature('hc2-flow-setpoint')), 47.8);
  // The other features kept their external ids.
  for (const role of before) {
    assert.ok(s.roles(s.created()).includes(role), role);
  }
});

test('n° 17: a measured temperature at "---" (no sensor) still gives no feature; a sensor not typed either', async (t) => {
  const params = {
    ...fullParams(),
    8773: disabled('Flow temp actual value heat circuit 2'),
    8774: inactive('Flow temperature setpoint H2'),
  };
  const s = await setup(t, { params });
  assert.ok(!s.roles(s.discovered()).includes('hc2-temperature-flow'));
  assert.ok(
    !s.roles(s.discovered()).includes('hc2-flow-setpoint'),
    'dataType 0 alone: not guessed',
  );
  assert.ok(s.roles(s.discovered()).includes('hc2-setpoint'), 'circuit 2 is there');
});

test('n° 17: an extra parameter at "---" with its type: an empty feature of the right kind, then its value', async (t) => {
  const params = {
    ...fullParams(),
    1020: disabled('Heating curve slope', '', 'GRADIENT_SMALL'),
    8326: disabled('Burner modulation', '%', 'PERCENT'),
    8700: disabled('Outside temperature'),
  };
  const s = await setup(t, {
    params,
    config: { ...CONFIG, extra_parameters: '1020, 8326, 2000, 2001' },
  });
  s.bsb.params[2000] = inactive('Untyped');
  const offered = s.discovered();
  const slope = offered.features.find((f) => f.external_id === feature('param-1020'));
  assert.equal(slope.name, 'BSB 1020 Heating curve slope');
  assert.equal(slope.category, 'unknown');
  assert.equal(slope.type, 'decimal');
  const modulation = offered.features.find((f) => f.external_id === feature('param-8326'));
  assert.equal(modulation.name, 'BSB 8326 Burner modulation (%)');
  assert.ok(!s.roles(offered).includes('param-2000'), 'no type: not guessed');
  assert.ok(!s.roles(offered).includes('param-2001'));
  await s.create();
  await s.advance(40 * SECOND);
  assert.deepEqual(s.statesOf('param-1020'), []);
  assert.deepEqual(s.statesOf('param-8326'), []);
  assert.match(
    s.status(),
    /Paramètres supplémentaires que BSB-LAN donne à « --- » pour l'instant : 1020, 8326\. Leur fonctionnalité existe/,
  );
  assert.match(s.status(), /sans fonctionnalité : 2000 \(inactif, « --- »\), 2001 \(inactif/);
  // The value comes: published as the kind fixed at "---".
  s.bsb.params[1020] = { ...s.bsb.params[1020], value: '1.46' };
  s.bsb.params[8326] = { ...s.bsb.params[8326], value: '42' };
  await s.advance(31 * SECOND);
  assert.equal(s.gladys.fake.lastState(feature('param-1020')), 1.46);
  assert.equal(s.gladys.fake.lastState(feature('param-8326')), 42);
  assert.doesNotMatch(s.status(), /pour l'instant : 1020/);
});

test('n° 17: an extra parameter in °F or in error at "---": no feature, said with why', async (t) => {
  const params = {
    ...fullParams(),
    2002: disabled('Hot', '°F', 'TEMP_WORD'),
    2003: { ...disabled('Gone'), error: 7, value: '' },
  };
  const s = await setup(t, { params, config: { ...CONFIG, extra_parameters: '2002, 2003' } });
  assert.ok(!s.roles(s.discovered()).includes('param-2002'));
  assert.ok(!s.roles(s.discovered()).includes('param-2003'));
  await s.create();
  await s.advance(31 * SECOND);
  assert.match(s.status(), /2002 \(inactif, « --- »\)/);
  assert.match(s.status(), /2003 \(erreur de BSB-LAN/);
});

test('n° 17 (0.4.1 r1 minor): a created extra feature whose parameter turns "---" without a type is "waiting", not "without a feature"', async (t) => {
  const slope = {
    ...disabled('Heating curve slope', '', 'GRADIENT_SMALL'),
    value: '1.46',
    payload: '0092',
  };
  const s = await setup(t, {
    params: { ...fullParams(), 1020: slope },
    config: { ...CONFIG, extra_parameters: '1020' },
  });
  await s.create();
  await s.advance(31 * SECOND);
  assert.equal(s.gladys.fake.lastState(feature('param-1020')), 1.46);
  s.bsb.params[1020] = inactive('Heating curve slope');
  const count = s.statesOf('param-1020').length;
  await s.advance(31 * SECOND);
  assert.doesNotMatch(s.status(), /sans fonctionnalité/);
  assert.match(s.status(), /que BSB-LAN donne à « --- » pour l'instant : 1020\./);
  assert.equal(s.statesOf('param-1020').length, count, 'nothing published');
});

test('n° 17: a command on a setpoint at "---" is refused as before, nothing written', async (t) => {
  const params = {
    ...fullParams(),
    710: disabled('Comfort setpoint'),
    1000: { ...fullParams()[1000], value: '2', desc: 'Reduced' },
    1010: disabled('Comfort setpoint HC2'),
  };
  const s = await setup(t, { params, config: { ...CONFIG, allow_commands: true } });
  await s.create();
  assert.ok(s.roles(s.created()).includes('heating-setpoint'));
  assert.ok(s.roles(s.created()).includes('hc2-setpoint'));
  for (const role of ['heating-setpoint', 'hc2-setpoint']) {
    const ack = await s.command(role, 21);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /710|1010|plage permise|valeur/);
  }
  assert.deepEqual(s.bsb.writes(), []);
});

test('n° 17: without the option, a command on a setpoint at "---" is refused too, nothing written', async (t) => {
  const params = { ...fullParams(), 710: disabled('Comfort setpoint') };
  const s = await setup(t, { params });
  await s.create();
  const ack = await s.command('heating-setpoint', 21);
  assert.equal(ack.success, false);
  assert.deepEqual(s.bsb.writes(), []);
});
