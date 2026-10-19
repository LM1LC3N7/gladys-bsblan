import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterOf,
  apiVersionOf,
  cleanText,
  decode,
  energy,
  temperature,
  writeOutcome,
} from '../src/params.js';
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
    version: '5.1.0',
    bus: 'bsb',
    busName: 'BSB',
    writable: true,
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

test('/JI strict (M4): writable only absent, 1, true or "1"; commands on BSB or LPB only', () => {
  for (const value of [1, true, '1', undefined]) {
    assert.equal(adapterOf({ ...bsbInfo(), buswritable: value }).writable, true, String(value));
  }
  for (const value of [0, false, '0', 2, 'yes', null, '', {}]) {
    assert.equal(adapterOf({ ...bsbInfo(), buswritable: value }).writable, false, String(value));
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
