// -----------------------------------------------------------------------------
// The BSB-LAN parameters this integration reads and writes, and their
// decoding (pure). Numbers and names from python-bsblan 6.1.10
// (`constants.py`, `models.py`): heating circuit 1, hot water, outside
// temperature, energy brought in, and the PPS room-unit parameters (15000+).
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

/** What one poll reads, by bus. */
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
  ],
  pps: [P.PPS_MODE, P.PPS_SETPOINT, P.PPS_MIN, P.PPS_MAX, P.PPS_ROOM, P.PPS_OUTDOOR],
};

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

/** The decoded values of one poll (`answer`: the /JQ answers merged). */
export function decode(bus, answer) {
  const values = { fahrenheit: false };
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
    setTemperature('heatingSetpoint', P.PPS_SETPOINT, 0, 95);
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
 * The adapter information (/JI), python-bsblan `Device`: the MAC address
 * (the stable id of the device), the firmware version, the bus (BSB, LPB or
 * PPS) and whether writing to the bus is allowed (`buswritable`).
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
  const writable = field(info, 'buswritable');
  return {
    mac: hex && hex !== '000000000000' && hex !== 'ffffffffffff' ? hex : undefined,
    version: cleanText(String(field(info, 'version') ?? ''))?.slice(0, 40),
    bus: busText === 'PPS' ? 'pps' : 'bsb',
    busName: ['BSB', 'LPB', 'PPS'].includes(busText) ? busText : 'BSB',
    // python-bsblan `is_bus_writable`: unknown counts as writable; 0 or false never.
    writable: !(writable === 0 || writable === false || writable === '0'),
  };
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
