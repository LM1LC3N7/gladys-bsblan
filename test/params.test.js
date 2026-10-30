import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessOf,
  adapterOf,
  apiVersionOf,
  busWritableOf,
  cleanText,
  decode,
  energy,
  firmwareOf,
  temperature,
  writeAccess,
  writeOutcome,
} from '../src/params.js';
import { CAPTURE_MAC_ID, info5_0_111, info5_1_33, jqAnswer5x } from './fixtures/captures.js';
import { bsbInfo, bsbParams, ppsParams } from './fixtures/fakeBsbLan.js';

test('decode: a BSB controller (python-bsblan fixtures)', () => {
  const v = decode('bsb', bsbParams());
  assert.deepEqual(v.mode, { code: 3, key: 'comfort' });
  assert.equal(v.heatingSetpoint, 20);
  assert.equal(v.heatingMin, 10);
  assert.equal(v.heatingMax, 28);
  assert.equal(v.room, 19.3);
  assert.equal(v.outdoor, 7.6);
  assert.deepEqual(v.status, { code: 114, desc: 'Heating mode comfort' });
  assert.deepEqual(v.dhwMode, { code: 1, key: 'on' });
  assert.equal(v.dhwSetpoint, 50);
  assert.equal(v.dhwMax, 65);
  assert.equal(v.dhwPump, 1);
  assert.equal(v.energy, 7968);
  assert.equal(v.fahrenheit, false);
});

test('decode: PPS', () => {
  const v = decode('pps', ppsParams());
  assert.deepEqual(v.mode, { code: 0, key: 'automatic' });
  assert.equal(v.ppsSetpoint, 20.5);
  assert.equal(v.heatingSetpoint, undefined, 'never the writable thermostat');
  assert.equal(v.room, 19.8);
  assert.equal(v.outdoor, 5);
});

test('inactive, erroneous, implausible or odd values are unknown', () => {
  const entry = (value, extra = {}) => ({ value, unit: '°C', ...extra });
  for (const value of ['---', '', 'None', null, undefined, '1e3', '20,5', ' ', {}, [], true]) {
    assert.deepEqual(temperature(entry(value), -60, 120), {}, String(value));
  }
  assert.deepEqual(temperature(entry('20.0', { error: 7 }), -60, 120), {});
  assert.deepEqual(temperature(entry('150.0'), -60, 120), {});
  assert.deepEqual(temperature(entry('20.0', { unit: 'bar' }), -60, 120), {});
  assert.deepEqual(temperature(entry('20.0', { unit: '&#176;C' }), -60, 120), { value: 20 });
  assert.deepEqual(temperature(entry('20.0', { unit: 'Â°C' }), -60, 120), { value: 20 });
  assert.deepEqual(temperature(entry('68.0', { unit: '°F' }), -60, 120), { fahrenheit: true });
  const v = decode('bsb', { 700: { value: '9' }, 8820: { value: '0' } });
  assert.deepEqual(v.mode, { code: 9, key: undefined });
  assert.equal(v.dhwPump, 0);
});

test('only own keys are read: no prototype pollution', () => {
  const answer = JSON.parse(
    '{"__proto__": {"value": "30.0", "unit": "°C"}, "710": {"value": "21.0"}}',
  );
  const v = decode('bsb', answer);
  assert.equal(v.heatingSetpoint, 21);
  assert.equal(v.room, undefined);
  assert.equal({}.value, undefined);
  const inherited = Object.create({ 710: { value: '25.0' } });
  assert.equal(decode('bsb', inherited).heatingSetpoint, undefined);
});

test('energy: "7968 kWh", MWh, a number with its unit; never negative', () => {
  assert.equal(energy({ value: '7968 kWh', unit: '' }), 7968);
  assert.equal(energy({ value: '1.5 MWh', unit: '' }), 1500);
  assert.equal(energy({ value: '250', unit: 'Wh' }), 0.25);
  assert.equal(energy({ value: '12', unit: 'kWh' }), 12);
  assert.equal(energy({ value: '-1', unit: 'kWh' }), undefined);
  assert.equal(energy({ value: '12', unit: 'l' }), undefined);
  assert.equal(energy({ value: '12 kW', unit: '' }), undefined);
});

test('texts of the controller are bounded and printable', () => {
  assert.equal(cleanText('a\u0000b\nc'), 'a b c');
  assert.equal(cleanText('x'.repeat(500)).length, 120);
  assert.equal(cleanText('   '), undefined);
  assert.equal(cleanText(5), undefined);
});

test('/JI: the MAC is the id; bus and write access', () => {
  assert.deepEqual(adapterOf(bsbInfo()), {
    mac: '008041196990',
    version: '5.1.33-20261027002928',
    bus: 'bsb',
    busName: 'BSB',
    writable: true,
    flagBuggy: false,
    commandBus: true,
  });
  assert.equal(adapterOf({ ...bsbInfo(), MAC: '00:00:00:00:00:00' }).mac, undefined);
  assert.equal(adapterOf({ ...bsbInfo(), MAC: 'nope' }).mac, undefined);
  assert.equal(adapterOf({ ...bsbInfo(), MAC: '00-80-41-19-69-90' }).mac, '008041196990');
  assert.equal(adapterOf({ ...bsbInfo(), bus: 'PPS' }).bus, 'pps');
  assert.equal(adapterOf({ ...bsbInfo(), bus: 'LPB' }).busName, 'LPB');
  assert.equal(adapterOf({ ...bsbInfo(), buswritable: 0 }).writable, false);
  assert.equal(adapterOf({ ...bsbInfo(), buswritable: undefined }).writable, true);
  assert.equal(adapterOf(null), undefined);
});

test('/JI (M4, redone for t/11458): writable absent, 1, 2, true, "Yes"...; read only 0...; else unknown', () => {
  for (const value of [1, 2, true, '1', 'yes', 'RW', undefined]) {
    assert.equal(adapterOf({ ...bsbInfo(), buswritable: value }).writable, true, String(value));
  }
  for (const value of [0, false, '0', 'No', 'RO']) {
    assert.equal(adapterOf({ ...bsbInfo(), buswritable: value }).writable, false, String(value));
  }
  for (const value of [null, '', {}, 7, 'maybe']) {
    assert.equal(
      adapterOf({ ...bsbInfo(), buswritable: value }).writable,
      undefined,
      String(value),
    );
  }
  assert.equal(adapterOf({ ...bsbInfo(), bus: 'LPB' }).commandBus, true);
  assert.equal(adapterOf({ ...bsbInfo(), bus: 'PPS' }).commandBus, false);
  const noBus = adapterOf({ ...bsbInfo(), bus: undefined });
  assert.equal(noBus.busName, 'unknown');
  assert.equal(noBus.commandBus, false);
  assert.equal(adapterOf({ ...bsbInfo(), bus: 'CAN' }).commandBus, false);
});

test('/JV: 1.0 at least', () => {
  assert.equal(apiVersionOf({ api_version: '2.0' }), '2.0');
  assert.equal(apiVersionOf({ api_version: '1.3' }), '1.3');
  assert.equal(apiVersionOf({ api_version: '0.9' }), undefined);
  assert.equal(apiVersionOf({ api_version: 'x' }), undefined);
  assert.equal(apiVersionOf({}), undefined);
});

test('/JS: 1 written, 2 refused, anything else unknown', () => {
  assert.equal(writeOutcome({ 700: { status: 1 } }, '700'), 'ok');
  assert.equal(writeOutcome({ status: 1 }, '700'), 'ok');
  assert.equal(writeOutcome({ 700: { status: '2' } }, '700'), 'refused');
  assert.equal(writeOutcome({ 700: { status: 0 } }, '700'), 'unknown');
  assert.equal(writeOutcome({}, '700'), 'unknown');
  assert.equal(writeOutcome({ 710: { status: 1 } }, '700'), 'unknown');
});

// --- Bus write access: the real /JI and /JQ of BSB-LAN 5.x (forum t/11458) ----

test('/JI of 5.0.111: buswritable is never believed (printed from a float with %d)', () => {
  for (const value of [0, 1, 1072693248, -1]) {
    const info = adapterOf(info5_0_111(value));
    assert.equal(info.writable, undefined, String(value));
    assert.equal(info.flagBuggy, true);
    assert.equal(info.commandBus, true);
    assert.equal(info.mac, CAPTURE_MAC_ID);
  }
  assert.deepEqual(firmwareOf('5.0.111-20260211204302'), [5, 0, 111]);
  assert.deepEqual(firmwareOf('5.1.18'), [5, 1, 18]);
  assert.equal(adapterOf({ ...info5_0_111(1), version: '5.1.18-x' }).writable, undefined);
  assert.equal(
    adapterOf({ ...info5_0_111(1), version: '4.2.53-20250101224944' }).writable,
    undefined,
  );
});

test('/JI from 5.1.19: 0 read only, 1 or 2 writable, anything else unknown', () => {
  assert.equal(adapterOf(info5_1_33(1)).writable, true);
  assert.equal(adapterOf(info5_1_33(2)).writable, true);
  assert.equal(adapterOf(info5_1_33(0)).writable, false);
  assert.equal(adapterOf({ ...info5_1_33(0), version: '5.1.19-x' }).writable, false);
  assert.equal(adapterOf(info5_1_33(1072693248)).writable, undefined);
  assert.equal(adapterOf(info5_1_33(1)).flagBuggy, false);
  // A version that cannot be read: the value is taken as it is.
  assert.equal(adapterOf({ ...info5_1_33(0), version: 'dev' }).writable, false);
  assert.equal(adapterOf({ ...info5_1_33(1), version: undefined }).writable, true);
});

test('buswritable: every form that means writable or read only, nothing ambiguous', () => {
  for (const value of [
    1,
    2,
    true,
    '1',
    '2',
    'Yes',
    ' yes ',
    'RW',
    'rw',
    'true',
    'On',
    'read/write',
  ]) {
    assert.equal(busWritableOf(value), true, JSON.stringify(value));
  }
  for (const value of [0, false, '0', 'No', 'RO', 'read only', 'readonly', 'false', 'off']) {
    assert.equal(busWritableOf(value), false, JSON.stringify(value));
  }
  for (const value of [
    null,
    '',
    3,
    -1,
    1.5,
    NaN,
    1072693248,
    'maybe',
    'yes!',
    {},
    [],
    'x'.repeat(30),
  ]) {
    assert.equal(busWritableOf(value), undefined, JSON.stringify(value));
  }
  // '1 ' trims to '1': writable (the list above holds the strings that stay ambiguous).
  assert.equal(busWritableOf('1 '), true);
});

test('/JQ of 5.x: the access of each parameter (readwrite, else the older readonly)', () => {
  const answer = jqAnswer5x();
  assert.equal(accessOf(answer[700]), 'rw');
  assert.equal(accessOf(answer[8000]), 'ro');
  assert.equal(accessOf({ ...answer[700], readwrite: 2 }), 'wo');
  assert.equal(accessOf({ ...answer[700], readwrite: '1' }), 'ro');
  assert.equal(accessOf({ ...answer[700], readwrite: 3 }), undefined);
  assert.equal(accessOf({ ...answer[700], readwrite: 'x' }), undefined);
  const legacy = { ...answer[700] };
  delete legacy.readwrite;
  assert.equal(accessOf(legacy), undefined);
  assert.equal(accessOf({ ...legacy, readonly: 0 }), 'rw');
  assert.equal(accessOf({ ...legacy, readonly: 1 }), 'ro');
  // readwrite wins over the deprecated readonly.
  assert.equal(accessOf({ ...answer[700], readonly: 1 }), 'rw');
  const values = decode('bsb', answer);
  assert.equal(values.access['700'], 'rw');
  assert.equal(values.access['8740'], 'ro');
  assert.equal(values.mode.key, 'automatic');
  assert.equal(values.heatingSetpoint, 20);
  // No prototype pollution through the keys of the answer.
  const polluted = decode('bsb', JSON.parse('{"__proto__": {"readwrite": 0, "value": "1"}}'));
  assert.equal(Object.getPrototypeOf(polluted.access), Object.prototype);
  assert.equal(polluted.access.__proto__, Object.prototype);
});

test('write access: the parameter decides first, then /JI', () => {
  const buggy = adapterOf(info5_0_111(0));
  assert.equal(writeAccess('rw', buggy), 'yes', 'the report: 5.0.111, DEFAULT_FLAG 0');
  assert.equal(writeAccess('wo', buggy), 'yes');
  assert.equal(writeAccess('ro', buggy), 'readOnlyParam');
  assert.equal(writeAccess(undefined, buggy), 'unknown');
  assert.equal(writeAccess('ro', adapterOf(info5_1_33(1))), 'readOnlyParam', 'locked parameter');
  assert.equal(writeAccess(undefined, adapterOf(info5_1_33(1))), 'yes');
  assert.equal(writeAccess(undefined, adapterOf(info5_1_33(0))), 'readOnlyBus');
});
