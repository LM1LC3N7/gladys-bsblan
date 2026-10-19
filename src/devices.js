// -----------------------------------------------------------------------------
// The adapter and its controller -> one Gladys device and its states (pure).
//
// `ext:<selector>:bsblan:<mac>`: one device per BSB-LAN adapter, keyed by its
// MAC address (/JI, 12 lowercase hex digits): stable when the IP address
// changes. Heating circuit 1 only in this version. The feature roles (the
// last part of their external ids) are published forever: never rename them.
//
// A feature appears once its parameter gave a value; a device published
// again never loses a feature: those of the device already created in
// Gladys are kept as they are (the core would mark it `structure_changed`,
// and "Update" would delete the missing feature and its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the boiler. The
// commands are the heating mode (`text/select`), the comfort setpoint
// (`thermostat/target-temperature`) and the hot water setpoint
// (`water-heater/target-temperature`), refused unless the configuration
// allows them (src/app.js). The hot water pump is read-only `unknown/binary`.
//
// Energy (lot 6 and wave 2 lessons): "energy brought in" (3113) is a text
// of the controller ("7968 kWh") with no documented reset or resolution;
// nothing proves it is a reliable cumulative index, so it is a plain
// `unknown/decimal` sensor, the unit in its name, never billed by the core.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on `temperature-sensor`,
// `thermostat` and `water-heater`. Water, outside temperatures and setpoints
// read only are `probe`, kept out of the room temperature of the core; only
// the room temperature is `decimal`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, SETPOINT_LIMITS } from './constants.js';
import { SELECTABLE } from './params.js';
import {
  DEVICE_NAME,
  DHW_MODE_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  STATE_TEXTS,
  word,
} from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const probe = (min = -60, max = 120) =>
  sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    min,
    max,
  });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/** The features, by role. */
export function definitionOf(role) {
  switch (role) {
    case F.MODE:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      };
    case F.MODE_STATE:
    case F.HEATING_STATUS:
    case F.DHW_MODE:
      return text;
    case F.HEATING_SETPOINT:
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: SETPOINT_LIMITS.heating.min,
        max: SETPOINT_LIMITS.heating.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.DHW_SETPOINT:
      return {
        category: C.WATER_HEATER,
        type: T.WATER_HEATER.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The slider stops at the hard ceiling; the configured one refuses below it.
        min: SETPOINT_LIMITS.dhw.min,
        max: SETPOINT_LIMITS.dhw.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.HEATING_SETPOINT_REDUCED:
    case F.PPS_SETPOINT:
    case F.DHW_SETPOINT_REDUCED:
      return probe(0, 95);
    case F.TEMP_ROOM:
      return sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: -60,
        max: 120,
      });
    case F.TEMP_OUTDOOR:
    case F.TEMP_DHW:
      return probe();
    case F.DHW_PUMP:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
    case F.ENERGY_TOTAL:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 100_000_000 });
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Where each read-only number comes from in the decoded values (src/params.js decode). */
const NUMBERS = {
  [F.HEATING_SETPOINT]: (v) => v.heatingSetpoint,
  [F.HEATING_SETPOINT_REDUCED]: (v) => v.heatingSetpointReduced,
  [F.PPS_SETPOINT]: (v) => v.ppsSetpoint,
  [F.TEMP_ROOM]: (v) => v.room,
  [F.TEMP_OUTDOOR]: (v) => v.outdoor,
  [F.DHW_SETPOINT]: (v) => v.dhwSetpoint,
  [F.DHW_SETPOINT_REDUCED]: (v) => v.dhwSetpointReduced,
  [F.TEMP_DHW]: (v) => v.dhw,
  [F.DHW_PUMP]: (v) => v.dhwPump,
  [F.ENERGY_TOTAL]: (v) => v.energy,
};

/** Display order. */
export const ROLES = [
  F.MODE,
  F.MODE_STATE,
  F.HEATING_STATUS,
  F.HEATING_SETPOINT,
  F.HEATING_SETPOINT_REDUCED,
  F.PPS_SETPOINT,
  F.TEMP_ROOM,
  F.TEMP_OUTDOOR,
  F.DHW_MODE,
  F.DHW_SETPOINT,
  F.DHW_SETPOINT_REDUCED,
  F.TEMP_DHW,
  F.DHW_PUMP,
  F.ENERGY_TOTAL,
];
export const COMMAND_ROLES = [F.MODE, F.HEATING_SETPOINT, F.DHW_SETPOINT];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, mac) => gladys.externalIds('bsblan', mac);

/** The MAC and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:bsblan:([0-9a-f]{12}):([a-z0-9-]+)$/.exec(externalId);
  if (!match || !ROLES.includes(match[2])) {
    return undefined;
  }
  return { mac: match[1], role: match[2] };
}

/** The MAC of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:bsblan:([0-9a-f]{12})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The roles the values of one poll report. The select only on BSB/LPB with a known mode. */
export function reportedRoles(values, bus) {
  const roles = new Set();
  if (values.mode !== undefined) {
    roles.add(F.MODE_STATE);
    if (bus !== 'pps') {
      roles.add(F.MODE);
    }
  }
  if (values.status !== undefined) {
    roles.add(F.HEATING_STATUS);
  }
  if (values.dhwMode !== undefined) {
    roles.add(F.DHW_MODE);
  }
  for (const [role, valueOf] of Object.entries(NUMBERS)) {
    if (valueOf(values) !== undefined) {
      roles.add(role);
    }
  }
  return roles;
}

export function modeOptions(language) {
  return SELECTABLE.map((key, index) => ({
    value: key,
    label: word(MODE_NAMES[key], language),
    sort_order: index,
  }));
}

/**
 * The Gladys device of the adapter. `roles`: those seen; `adapter`: what
 * /JI said (when read); `created`: the device already created in Gladys,
 * whose features are kept when the new build lacks them.
 */
export function buildDevice(gladys, mac, { roles, adapter, model, language, created }) {
  const ids = deviceIds(gladys, mac);
  const params = [{ name: 'mac', value: mac.match(/../g).join(':') }];
  if (adapter) {
    params.push({ name: 'bus', value: adapter.busName });
    if (adapter.version) {
      params.push({ name: 'firmware', value: adapter.version });
    }
  }
  if (model) {
    params.push({ name: 'controller', value: model });
  }
  const built = {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: model ? `BSB-LAN ${model}` : 'BSB-LAN',
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      ...(role === F.MODE ? { supported_options: modeOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The text of a mode read. */
function modeText(mode, names, language) {
  if (mode.key && Object.hasOwn(names, mode.key)) {
    return word(names[mode.key], language);
  }
  return word(STATE_TEXTS.unknownMode(mode.code), language);
}

/**
 * The current values of the device. `status`: 'online', or 'offline' (the
 * adapter does not answer) and 'other' (another adapter answers): then only
 * the mode text changes, Gladys keeps the last value of the others.
 */
export function deviceStates(ids, values, { status = 'online', bus, language }) {
  if (status !== 'online') {
    const shown = status === 'other' ? STATE_TEXTS.otherAdapter : STATE_TEXTS.offline;
    return [{ device_feature_external_id: ids.feature(F.MODE_STATE), text: word(shown, language) }];
  }
  const states = [];
  if (values.mode !== undefined) {
    states.push({ role: F.MODE_STATE, text: modeText(values.mode, MODE_NAMES, language) });
    if (bus !== 'pps' && SELECTABLE.includes(values.mode.key)) {
      states.push({ role: F.MODE, text: values.mode.key });
    }
  }
  if (values.status !== undefined) {
    states.push({
      role: F.HEATING_STATUS,
      text: values.status.desc ?? word(STATE_TEXTS.statusCode(values.status.code), language),
    });
  }
  if (values.dhwMode !== undefined) {
    states.push({ role: F.DHW_MODE, text: modeText(values.dhwMode, DHW_MODE_NAMES, language) });
  }
  for (const [role, valueOf] of Object.entries(NUMBERS)) {
    const value = valueOf(values);
    if (value !== undefined && Number.isFinite(value)) {
      states.push({ role, state: value });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
