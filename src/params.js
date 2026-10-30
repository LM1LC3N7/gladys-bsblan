// -----------------------------------------------------------------------------
// The BSB-LAN parameters this integration reads and writes, and their
// decoding (pure). Numbers and names from python-bsblan 6.1.10
// (`constants.py`, `models.py`): heating circuits 1 and 2, hot water, outside
// temperature, energy brought in, and the PPS room-unit parameters (15000+);
// the flow, status and boiler numbers from the BSB-LAN parameter names
// (localization/LANG_EN.h, LANG_DE_LEGACY.h: 8001, 8003, 8005, 8310, 8743,
// 8744, 8773, 8774, 7870, 7881, 6800, 6801). Their type is not fixed by
// BSB-LAN (the parameter tables are made per controller): each value is
// checked as it comes.
//
// Every value BSB-LAN sends is a text in an object
// `{ name, value, desc, unit, dataType, error, ... }`. A value is unknown when
// it is missing, inactive ("---", "", "None", null: BSB-LAN's
// `replaceDisabled`), carries an error code, is not a plain number where a
// number is expected, or lies outside its plausible range. Only own keys of
// the answer are read (never an inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

export const P = {
  // Heating circuit 1 (BSB/LPB).
  MODE: '700',
  COMFORT: '710',
  REDUCED: '712',
  PROTECTIVE: '714',
  COMFORT_MAX: '716',
  STATUS: '8000',
  ROOM: '8740',
  FLOW_SETPOINT: '8744',
  FLOW: '8743',
  // Heating circuit 2 (BSB/LPB).
  MODE2: '1000',
  COMFORT2: '1010',
  REDUCED2: '1012',
  PROTECTIVE2: '1014',
  COMFORT_MAX2: '1016',
  STATUS2: '8001',
  FLOW_SETPOINT2: '8774',
  FLOW2: '8773',
  // Sensors.
  OUTDOOR: '8700',
  ENERGY: '3113',
  // Hot water.
  DHW_MODE: '1600',
  DHW_NOMINAL: '1610',
  DHW_REDUCED: '1612',
  DHW_NOMINAL_MAX: '1614',
  DHW_TEMP: '8830',
  DHW_PUMP: '8820',
  DHW_STATUS: '8003',
  // The boiler.
  BOILER_STATUS: '8005',
  BOILER_TEMP: '8310',
  BURNER_STAGE_1: '7881',
  BURNER_FAULT: '7870',
  FAULT_DATE: '6800',
  FAULT_CODE: '6801',
  // The controller.
  IDENTIFICATION: '6224',
  // PPS bus (one room-unit circuit).
  PPS_MODE: '15000',
  PPS_SETPOINT: '15004',
  PPS_MIN: '15006',
  PPS_MAX: '15007',
  PPS_ROOM: '15008',
  PPS_OUTDOOR: '15030',
};

/**
 * What one poll reads, by bus. On BSB/LPB, the rest of heating circuit 2
 * (`HC2_REST`) only while its mode (1000) is not known to be missing: a
 * controller without circuit 2 costs one parameter per poll.
 */
export const POLL = {
  bsb: [
    P.MODE,
    P.COMFORT,
    P.REDUCED,
    P.PROTECTIVE,
    P.COMFORT_MAX,
    P.STATUS,
    P.ROOM,
    P.OUTDOOR,
    P.DHW_MODE,
    P.DHW_NOMINAL,
    P.DHW_REDUCED,
    P.DHW_NOMINAL_MAX,
    P.DHW_TEMP,
    P.DHW_PUMP,
    P.ENERGY,
    P.FLOW_SETPOINT,
    P.FLOW,
    P.DHW_STATUS,
    P.BOILER_STATUS,
    P.BOILER_TEMP,
    P.BURNER_STAGE_1,
    P.BURNER_FAULT,
    P.FAULT_DATE,
    P.FAULT_CODE,
    P.MODE2,
  ],
  pps: [P.PPS_MODE, P.PPS_SETPOINT, P.PPS_MIN, P.PPS_MAX, P.PPS_ROOM, P.PPS_OUTDOOR],
};

export const HC2_REST = [
  P.COMFORT2,
  P.REDUCED2,
  P.PROTECTIVE2,
  P.COMFORT_MAX2,
  P.STATUS2,
  P.FLOW_SETPOINT2,
  P.FLOW2,
];

/**
 * Heating circuit 1 operating mode (700), python-bsblan `Validation.HVAC_MODES`
 * and the BSB-LAN texts: 0 protection (frost protection only), 1 automatic
 * (time program), 2 reduced, 3 comfort. All four can be selected.
 */
export const MODES = { 0: 'protection', 1: 'automatic', 2: 'reduced', 3: 'comfort' };
export const SELECTABLE = ['automatic', 'comfort', 'reduced', 'protection'];
export const MODE_CODES = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, Number(k)]));

/** PPS operating mode (15000), raw values (python-bsblan `PPS_HVAC_MODE_FROM_BSBLAN`). */
export const PPS_MODES = { 0: 'automatic', 1: 'manual', 2: 'off' };

/** Hot water operating mode (1600): off, on, eco. */
export const DHW_MODES = { 0: 'off', 1: 'on', 2: 'eco' };
export const DHW_SELECTABLE = ['on', 'eco', 'off'];
export const DHW_MODE_CODES = Object.fromEntries(
  Object.entries(DHW_MODES).map(([k, v]) => [v, Number(k)]),
);

const INACTIVE = new Set(['---', '', 'None']);
const NUMBER = /^-?\d{1,6}(\.\d{1,4})?$/;
const INTEGER = /^\d{1,5}$/;
const CELSIUS = new Set(['°C', '&deg;C', '&#176;C', 'Â°C', 'C', '']);
const FAHRENHEIT = new Set(['°F', '&deg;F', '&#176;F', 'Â°F', 'F']);
const ENERGY_UNITS = { Wh: 0.001, kWh: 1, MWh: 1000 };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The entry of a parameter in an answer: an own key holding an object, else undefined. */
export function entryOf(answer, id) {
  if (!isObject(answer) || !Object.hasOwn(answer, id)) {
    return undefined;
  }
  const entry = answer[id];
  return isObject(entry) ? entry : undefined;
}

const field = (entry, key) => (Object.hasOwn(entry, key) ? entry[key] : undefined);

/** The raw text of an active value without error, else undefined. */
function rawOf(entry) {
  if (!entry) {
    return undefined;
  }
  const error = field(entry, 'error');
  if (error !== undefined && error !== 0 && error !== '0') {
    return undefined;
  }
  const value = field(entry, 'value');
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const text = String(value).trim();
  return INACTIVE.has(text) || text.length > 40 ? undefined : text;
}

/** A printable text of the controller, bounded (no control character). */
export function cleanText(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Control characters (C0, DEL, C1) become spaces, in one linear pass.
  let printable = '';
  for (const char of value.slice(0, 4 * LIMITS.textLength)) {
    const code = char.codePointAt(0);
    printable += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  const text = printable.replace(/\s+/g, ' ').trim().slice(0, LIMITS.textLength);
  return text === '' ? undefined : text;
}

/**
 * A temperature: a plain number in °C within [min, max]. `{ fahrenheit }`
 * when the controller speaks °F (the features are °C, fixed at creation).
 */
export function temperature(entry, min, max) {
  const text = rawOf(entry);
  if (text === undefined || !NUMBER.test(text)) {
    return {};
  }
  const unit = String(field(entry, 'unit') ?? '').trim();
  if (FAHRENHEIT.has(unit)) {
    return { fahrenheit: true };
  }
  if (!CELSIUS.has(unit)) {
    return {};
  }
  const value = Number(text);
  return value >= min && value <= max ? { value } : {};
}

/** An enumerated value: its code (an integer) and the controller's text. */
export function enumerated(entry) {
  const text = rawOf(entry);
  if (text === undefined || !INTEGER.test(text)) {
    return undefined;
  }
  return { code: Number(text), desc: cleanText(field(entry, 'desc')) };
}

/**
 * The energy brought in (3113): a STRING "7968 kWh" (python-bsblan
 * `EntityInfo`), or a number with its unit. In kWh, 0 – 100 000 000.
 */
export function energy(entry) {
  const text = rawOf(entry);
  if (text === undefined) {
    return undefined;
  }
  let number;
  let unit;
  const embedded = /^(\d{1,9}(?:\.\d{1,4})?)\s+(Wh|kWh|MWh)$/.exec(text);
  if (embedded) {
    [, number, unit] = embedded;
  } else if (NUMBER.test(text)) {
    number = text;
    unit = String(field(entry, 'unit') ?? '').trim();
  } else {
    return undefined;
  }
  if (!Object.hasOwn(ENERGY_UNITS, unit)) {
    return undefined;
  }
  const value = Math.round(Number(number) * ENERGY_UNITS[unit] * 1000) / 1000;
  return value >= 0 && value <= 100_000_000 ? value : undefined;
}

/**
 * A read-only parameter typed in the configuration, as BSB-LAN describes it
 * in the answer (`dataType`, `unit`, `name`): a temperature (°C), another
 * plain number (its unit in the name), or a text (an enumeration's
 * description, a date, a string). Undefined when inactive, in error, in °F,
 * or out of bounds.
 * @returns {{ kind: 'temperature' | 'number' | 'text', value?: number,
 *   text?: string, name?: string, unit: string } | undefined}
 */
export function extraOf(entry) {
  const text = rawOf(entry);
  if (text === undefined) {
    return undefined;
  }
  const unit = cleanText(String(field(entry, 'unit') ?? ''))?.slice(0, 12) ?? '';
  const name = cleanText(String(field(entry, 'name') ?? ''))?.slice(0, 60);
  const dataType = field(entry, 'dataType');
  const family = field(entry, 'dataType_family');
  const numeric = (dataType === 0 || family === 'VALS') && NUMBER.test(text);
  if (numeric) {
    if (FAHRENHEIT.has(unit)) {
      return undefined;
    }
    const value = Number(text);
    if (CELSIUS.has(unit) && unit !== '') {
      return value >= -60 && value <= 250
        ? { kind: 'temperature', value, name, unit: '°C' }
        : undefined;
    }
    return Math.abs(value) <= LIMITS.extraNumber
      ? { kind: 'number', value, name, unit }
      : undefined;
  }
  const desc = cleanText(field(entry, 'desc'));
  const shown = cleanText(desc && INTEGER.test(text) ? `${desc} (${text})` : (desc ?? text));
  return shown === undefined ? undefined : { kind: 'text', text: shown, name, unit };
}

/**
 * The decoded values of one poll (`answer`: the /JQ answers merged;
 * `extras`: the read-only parameters typed in the configuration).
 */
export function decode(bus, answer, extras = []) {
  const values = { fahrenheit: false, access: {}, extra: {} };
  for (const id of extras) {
    const read = extraOf(entryOf(answer, id));
    if (read) {
      values.extra[id] = read;
    }
  }
  if (isObject(answer)) {
    for (const id of Object.keys(answer)) {
      if (!/^\d{1,5}$/.test(id)) {
        continue;
      }
      const access = accessOf(entryOf(answer, id));
      if (access !== undefined) {
        values.access[id] = access;
      }
    }
  }
  const setTemperature = (key, id, min, max) => {
    const read = temperature(entryOf(answer, id), min, max);
    if (read.fahrenheit) {
      values.fahrenheit = true;
    } else if (read.value !== undefined) {
      values[key] = read.value;
    }
  };
  if (bus === 'pps') {
    const mode = enumerated(entryOf(answer, P.PPS_MODE));
    if (mode) {
      values.mode = { code: mode.code, key: PPS_MODES[mode.code] };
    }
    // Read only on PPS (v1): its own feature, never the writable thermostat.
    setTemperature('ppsSetpoint', P.PPS_SETPOINT, 0, 95);
    setTemperature('heatingMin', P.PPS_MIN, 0, 95);
    setTemperature('heatingMax', P.PPS_MAX, 0, 95);
    setTemperature('room', P.PPS_ROOM, -60, 120);
    setTemperature('outdoor', P.PPS_OUTDOOR, -60, 120);
    return values;
  }
  const mode = enumerated(entryOf(answer, P.MODE));
  if (mode) {
    values.mode = {
      code: mode.code,
      key: Object.hasOwn(MODES, mode.code) ? MODES[mode.code] : undefined,
    };
  }
  setTemperature('heatingSetpoint', P.COMFORT, 0, 95);
  setTemperature('heatingSetpointReduced', P.REDUCED, 0, 95);
  setTemperature('heatingMin', P.PROTECTIVE, 0, 95);
  setTemperature('heatingMax', P.COMFORT_MAX, 0, 95);
  setTemperature('room', P.ROOM, -60, 120);
  setTemperature('outdoor', P.OUTDOOR, -60, 120);
  const status = enumerated(entryOf(answer, P.STATUS));
  if (status) {
    values.status = status;
  }
  const dhwMode = enumerated(entryOf(answer, P.DHW_MODE));
  if (dhwMode) {
    values.dhwMode = {
      code: dhwMode.code,
      key: Object.hasOwn(DHW_MODES, dhwMode.code) ? DHW_MODES[dhwMode.code] : undefined,
    };
  }
  setTemperature('dhwSetpoint', P.DHW_NOMINAL, 0, 95);
  setTemperature('dhwSetpointReduced', P.DHW_REDUCED, 0, 95);
  setTemperature('dhwMax', P.DHW_NOMINAL_MAX, 0, 95);
  setTemperature('dhw', P.DHW_TEMP, -60, 120);
  const pump = enumerated(entryOf(answer, P.DHW_PUMP));
  if (pump) {
    values.dhwPump = pump.code === 0 ? 0 : 1;
  }
  setTemperature('flowSetpoint', P.FLOW_SETPOINT, 0, 120);
  setTemperature('flow', P.FLOW, -60, 120);
  // Heating circuit 2: nothing of it without its mode (1000).
  const mode2 = enumerated(entryOf(answer, P.MODE2));
  if (mode2) {
    values.mode2 = {
      code: mode2.code,
      key: Object.hasOwn(MODES, mode2.code) ? MODES[mode2.code] : undefined,
    };
    setTemperature('heating2Setpoint', P.COMFORT2, 0, 95);
    setTemperature('heating2SetpointReduced', P.REDUCED2, 0, 95);
    setTemperature('heating2Min', P.PROTECTIVE2, 0, 95);
    setTemperature('heating2Max', P.COMFORT_MAX2, 0, 95);
    setTemperature('flowSetpoint2', P.FLOW_SETPOINT2, 0, 120);
    setTemperature('flow2', P.FLOW2, -60, 120);
    const status2 = enumerated(entryOf(answer, P.STATUS2));
    if (status2) {
      values.status2 = status2;
    }
  }
  const dhwStatus = enumerated(entryOf(answer, P.DHW_STATUS));
  if (dhwStatus) {
    values.dhwStatus = dhwStatus;
  }
  const boilerStatus = enumerated(entryOf(answer, P.BOILER_STATUS));
  if (boilerStatus) {
    values.boilerStatus = boilerStatus;
  }
  setTemperature('boiler', P.BOILER_TEMP, -60, 150);
  for (const [key, id] of [
    ['burnerStage1', P.BURNER_STAGE_1],
    ['burnerFault', P.BURNER_FAULT],
  ]) {
    // An input of the controller (0 V / 230 V, off / on): 0 off, any other code on.
    const input = enumerated(entryOf(answer, id));
    if (input) {
      values[key] = input.code === 0 ? 0 : 1;
    }
  }
  const faultDate = rawOf(entryOf(answer, P.FAULT_DATE));
  if (faultDate !== undefined && /^[\d.:/ -]{5,25}$/.test(faultDate)) {
    values.lastFaultDate = faultDate;
  }
  const faultCode = enumerated(entryOf(answer, P.FAULT_CODE));
  if (faultCode) {
    values.lastFaultCode = faultCode;
  }
  const brought = energy(entryOf(answer, P.ENERGY));
  if (brought !== undefined) {
    values.energy = brought;
  }
  return values;
}

/** The controller identification (6224), e.g. "RVS21.831F/127". */
export function identificationOf(answer) {
  const text = rawOf(entryOf(answer, P.IDENTIFICATION));
  return text === undefined ? undefined : cleanText(text)?.slice(0, 40);
}

/**
 * The firmware versions whose `buswritable` (/JI) can be believed. Up to
 * 5.1.18, BSB-LAN printed that field from a `float` variable with `%d`
 * (BSB_LAN.ino, "dump configuration in JSON"): undefined behaviour in C,
 * the number shown (often 0, sometimes a large number) says nothing of the
 * real setting. Fixed in 5.1.19 (fredlcore/BSB-LAN 898ab77, 2026-09-14,
 * "Bugfixes for /JL and /JW": the variable became a `uint8_t`).
 */
export const BUSWRITABLE_FIXED = [5, 1, 19];

/** "5.0.111-20260211204302" -> [5, 0, 111], else undefined. */
export function firmwareOf(version) {
  const match = /^\s*(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:\D|$)/.exec(String(version ?? ''));
  return match ? match.slice(1, 4).map(Number) : undefined;
}

const before = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i];
    }
  }
  return false;
};

const WRITABLE_WORDS = new Set([
  '1',
  '2',
  'yes',
  'y',
  'true',
  'on',
  'rw',
  'read/write',
  'readwrite',
]);
const READ_ONLY_WORDS = new Set(['0', 'no', 'n', 'false', 'off', 'ro', 'read only', 'readonly']);

/**
 * What a `buswritable` value says: true (writable), false (read only), or
 * undefined (ambiguous: anything else). BSB-LAN sends a number, 0 or 1
 * (its OpenAPI also lists 2, "yes (technician)"); a boolean or a word
 * ("Yes", "RW", "No", "RO") is read the same way, case and spaces aside.
 */
export function busWritableOf(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1 || value === 2 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== 'string' || value.length > 20) {
    return undefined;
  }
  const word = value.trim().toLowerCase();
  if (WRITABLE_WORDS.has(word)) {
    return true;
  }
  return READ_ONLY_WORDS.has(word) ? false : undefined;
}

/**
 * The access BSB-LAN gives one parameter in a /JQ (or /JK, /JC) answer:
 * `readwrite` 0 read/write, 1 read only, 2 write only; the older
 * `readonly` (0 or 1, deprecated) when `readwrite` is missing. The firmware
 * computes it from the parameter's own flags AND the global write setting
 * (DEFAULT_FLAG, "Bus write access"): the most precise answer there is.
 * @returns {'rw' | 'ro' | 'wo' | undefined}
 */
export function accessOf(entry) {
  if (!entry) {
    return undefined;
  }
  const code = (value) =>
    typeof value === 'number' && Number.isInteger(value)
      ? value
      : typeof value === 'string' && /^\s*\d\s*$/.test(value)
        ? Number(value)
        : undefined;
  const readwrite = code(field(entry, 'readwrite'));
  if (readwrite !== undefined) {
    return ['rw', 'ro', 'wo'][readwrite];
  }
  const readonly = code(field(entry, 'readonly'));
  return readonly === 0 ? 'rw' : readonly === 1 ? 'ro' : undefined;
}

/**
 * The adapter information (/JI), python-bsblan `Device`: the MAC address
 * (the stable id of the device), the firmware version, the bus (BSB, LPB or
 * PPS) and whether writing to the bus is allowed (`buswritable`).
 *
 * `writable`: true, false, or undefined when unknown: an ambiguous value,
 * or a firmware before 5.1.19 (see BUSWRITABLE_FIXED), whose value is
 * never believed. Absent (the oldest firmwares, as python-bsblan): true.
 * The access of each parameter (accessOf) decides before it.
 */
export function adapterOf(info) {
  if (!isObject(info)) {
    return undefined;
  }
  const mac = String(field(info, 'MAC') ?? '')
    .trim()
    .toLowerCase();
  const hex = /^([0-9a-f]{2})([:-]?)([0-9a-f]{2})(\2[0-9a-f]{2}){4}$/.test(mac)
    ? mac.replace(/[:-]/g, '')
    : undefined;
  const busText = String(field(info, 'bus') ?? '')
    .trim()
    .toUpperCase();
  const busName = ['BSB', 'LPB', 'PPS'].includes(busText) ? busText : 'unknown';
  const version = cleanText(String(field(info, 'version') ?? ''))?.slice(0, 40);
  const firmware = firmwareOf(version);
  const flagBuggy = firmware !== undefined && before(firmware, BUSWRITABLE_FIXED);
  const raw = field(info, 'buswritable');
  let writable;
  if (raw === undefined) {
    writable = true;
  } else if (!flagBuggy) {
    writable = busWritableOf(raw);
  }
  return {
    mac: hex && hex !== '000000000000' && hex !== 'ffffffffffff' ? hex : undefined,
    version,
    bus: busText === 'PPS' ? 'pps' : 'bsb',
    busName,
    writable,
    /** The firmware prints a meaningless `buswritable` (before 5.1.19). */
    flagBuggy,
    /** Commands only on a BSB or LPB bus (never PPS, never an unknown bus). */
    commandBus: busName === 'BSB' || busName === 'LPB',
  };
}

/**
 * Whether a parameter may be written now: its own access (accessOf) in the
 * fresh read first (`rw`, `wo`: yes; `ro`: no), else what /JI said of the bus.
 * @returns {'yes' | 'readOnlyParam' | 'readOnlyBus' | 'unknown'}
 */
export function writeAccess(access, info) {
  if (access === 'ro') {
    return 'readOnlyParam';
  }
  if (access === 'rw' || access === 'wo') {
    return 'yes';
  }
  if (info?.writable === true) {
    return 'yes';
  }
  return info?.writable === false ? 'readOnlyBus' : 'unknown';
}

/**
 * The JSON-API version (/JV), python-bsblan `VersionResolver`: 1.0 at least,
 * else the firmware is not supported. Returns the text, or undefined.
 */
export function apiVersionOf(answer) {
  const text = isObject(answer) ? field(answer, 'api_version') : undefined;
  if (typeof text !== 'string' || !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(text.trim())) {
    return undefined;
  }
  const major = Number(text.trim().split('.')[0]);
  return major >= 1 ? text.trim() : undefined;
}

/**
 * The outcome of a write (/JS). BSB-LAN answers `{ "<id>": { "status": n } }`
 * (or `{ "status": n }`): 1 written; 2 refused (read-only parameter or bus
 * not writable): not applied; 0 failed on the bus, which does not say the
 * controller ignored it; anything else: unknown.
 * @returns {'ok' | 'refused' | 'unknown'}
 */
export function writeOutcome(answer, id) {
  const entry = entryOf(answer, id);
  const status = entry
    ? field(entry, 'status')
    : isObject(answer)
      ? field(answer, 'status')
      : undefined;
  const code = typeof status === 'string' && INTEGER.test(status) ? Number(status) : status;
  if (code === 1) {
    return 'ok';
  }
  if (code === 2) {
    return 'refused';
  }
  return 'unknown';
}
