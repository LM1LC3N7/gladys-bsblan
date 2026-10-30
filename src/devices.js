// -----------------------------------------------------------------------------
// The adapter and its controller -> one Gladys device and its states (pure).
//
// `ext:<selector>:bsblan:<mac>`: one device per BSB-LAN adapter, keyed by its
// MAC address (/JI, 12 lowercase hex digits): stable when the IP address
// changes. Heating circuits 1 and 2 (the second once the controller gives
// its mode, 1000), hot water, the boiler, and the read-only parameters typed
// in the configuration (`param-<id>`). The feature roles (the last part of
// their external ids) are published forever: never rename them.
//
// A feature appears once its parameter gave a value; a device published
// again never loses a feature: those of the device already created in
// Gladys are kept as they are (the core would mark it `structure_changed`,
// and "Update" would delete the missing feature and its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the boiler. The
// commands are the modes of circuits 1 and 2 and of the hot water
// (`text/select`), the comfort and reduced setpoints of both circuits
// (`thermostat/target-temperature`) and the two hot water setpoints
// (`water-heater/target-temperature`), refused unless the configuration
// allows them, except Protection and hot water Off (src/app.js). The hot
// water pump and the burner inputs are read-only `unknown/binary`.
//
// 712 and 1612 were read-only probes before 0.2.0 (`heating-setpoint-reduced`,
// `dhw-setpoint-reduced`): those features stay, read only, on the devices
// that have them (LEGACY_ROLES), and new devices get the writable ones.
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
import { EXTRA_PREFIX, FEATURES as F, SETPOINT_LIMITS } from './constants.js';
import { DHW_SELECTABLE, SELECTABLE } from './params.js';
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
    case F.HC2_MODE:
    case F.DHW_MODE_SELECT:
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
    case F.HC2_MODE_STATE:
    case F.HC2_STATUS:
    case F.DHW_STATUS:
    case F.BOILER_STATUS:
    case F.LAST_FAULT_DATE:
    case F.LAST_FAULT_CODE:
      return text;
    case F.HEATING_SETPOINT:
    case F.HEATING_REDUCED_TARGET:
    case F.HC2_SETPOINT:
    case F.HC2_REDUCED_TARGET:
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
    case F.DHW_REDUCED_TARGET:
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
    case F.TEMP_FLOW:
    case F.HC2_TEMP_FLOW:
      return probe();
    case F.FLOW_SETPOINT:
    case F.HC2_FLOW_SETPOINT:
      return probe(0, 120);
    case F.TEMP_BOILER:
      return probe(-60, 150);
    case F.DHW_PUMP:
    case F.BURNER_STAGE_1:
    case F.BURNER_FAULT:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
    case F.ENERGY_TOTAL:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 100_000_000 });
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** A read-only parameter of the configuration, by the kind of its first value (params.js extraOf). */
export function extraDefinitionOf(kind) {
  if (kind === 'temperature') {
    return probe(-60, 250);
  }
  if (kind === 'number') {
    return sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: -1_000_000, max: 1_000_000 });
  }
  return text;
}

/** The kind of a created feature of a read-only parameter, from what Gladys keeps. */
export function extraKindOf(feature) {
  if (feature?.category === C.TEMPERATURE_SENSOR) {
    return 'temperature';
  }
  if (feature?.category === C.UNKNOWN && feature?.type === T.SENSOR.DECIMAL) {
    return 'number';
  }
  return feature?.category === C.TEXT ? 'text' : undefined;
}

export const extraRole = (id) => `${EXTRA_PREFIX}${id}`;

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
  [F.HEATING_REDUCED_TARGET]: (v) => v.heatingSetpointReduced,
  [F.FLOW_SETPOINT]: (v) => v.flowSetpoint,
  [F.TEMP_FLOW]: (v) => v.flow,
  [F.HC2_SETPOINT]: (v) => v.heating2Setpoint,
  [F.HC2_REDUCED_TARGET]: (v) => v.heating2SetpointReduced,
  [F.HC2_FLOW_SETPOINT]: (v) => v.flowSetpoint2,
  [F.HC2_TEMP_FLOW]: (v) => v.flow2,
  [F.DHW_REDUCED_TARGET]: (v) => v.dhwSetpointReduced,
  [F.TEMP_BOILER]: (v) => v.boiler,
  [F.BURNER_STAGE_1]: (v) => v.burnerStage1,
  [F.BURNER_FAULT]: (v) => v.burnerFault,
};

/** Read-only probes of 712 and 1612 before 0.2.0: kept on the devices that have them, never offered again. */
export const LEGACY_ROLES = [F.HEATING_SETPOINT_REDUCED, F.DHW_SETPOINT_REDUCED];

/** Display order. */
export const ROLES = [
  F.MODE,
  F.MODE_STATE,
  F.HEATING_STATUS,
  F.HEATING_SETPOINT,
  F.HEATING_REDUCED_TARGET,
  F.HEATING_SETPOINT_REDUCED,
  F.PPS_SETPOINT,
  F.TEMP_ROOM,
  F.FLOW_SETPOINT,
  F.TEMP_FLOW,
  F.HC2_MODE,
  F.HC2_MODE_STATE,
  F.HC2_STATUS,
  F.HC2_SETPOINT,
  F.HC2_REDUCED_TARGET,
  F.HC2_FLOW_SETPOINT,
  F.HC2_TEMP_FLOW,
  F.TEMP_OUTDOOR,
  F.DHW_MODE_SELECT,
  F.DHW_MODE,
  F.DHW_STATUS,
  F.DHW_SETPOINT,
  F.DHW_REDUCED_TARGET,
  F.DHW_SETPOINT_REDUCED,
  F.TEMP_DHW,
  F.DHW_PUMP,
  F.BOILER_STATUS,
  F.TEMP_BOILER,
  F.BURNER_STAGE_1,
  F.BURNER_FAULT,
  F.LAST_FAULT_DATE,
  F.LAST_FAULT_CODE,
  F.ENERGY_TOTAL,
];
export const COMMAND_ROLES = [
  F.MODE,
  F.HEATING_SETPOINT,
  F.HEATING_REDUCED_TARGET,
  F.HC2_MODE,
  F.HC2_SETPOINT,
  F.HC2_REDUCED_TARGET,
  F.DHW_MODE_SELECT,
  F.DHW_SETPOINT,
  F.DHW_REDUCED_TARGET,
];

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
  if (!match || !(ROLES.includes(match[2]) || /^param-[1-9]\d{0,4}$/.test(match[2]))) {
    return undefined;
  }
  return { mac: match[1], role: match[2] };
}

/** The MAC of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:bsblan:([0-9a-f]{12})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** Text features, from the decoded values (a status shows the controller's text). */
const TEXTS = {
  [F.HEATING_STATUS]: (v) => v.status,
  [F.HC2_STATUS]: (v) => v.status2,
  [F.DHW_STATUS]: (v) => v.dhwStatus,
  [F.BOILER_STATUS]: (v) => v.boilerStatus,
  [F.LAST_FAULT_CODE]: (v) => v.lastFaultCode,
};

/**
 * The roles the values of one poll report. The selects only on BSB/LPB
 * with a known mode; never the legacy read-only probes (LEGACY_ROLES).
 */
export function reportedRoles(values, bus) {
  const roles = new Set();
  if (values.mode !== undefined) {
    roles.add(F.MODE_STATE);
    if (bus !== 'pps') {
      roles.add(F.MODE);
    }
  }
  if (values.mode2 !== undefined) {
    roles.add(F.HC2_MODE_STATE);
    roles.add(F.HC2_MODE);
  }
  if (values.dhwMode !== undefined) {
    roles.add(F.DHW_MODE);
    if (bus !== 'pps') {
      roles.add(F.DHW_MODE_SELECT);
    }
  }
  if (values.lastFaultDate !== undefined) {
    roles.add(F.LAST_FAULT_DATE);
  }
  for (const [role, valueOf] of Object.entries(TEXTS)) {
    if (valueOf(values) !== undefined) {
      roles.add(role);
    }
  }
  for (const [role, valueOf] of Object.entries(NUMBERS)) {
    if (valueOf(values) !== undefined && !LEGACY_ROLES.includes(role)) {
      roles.add(role);
    }
  }
  for (const id of Object.keys(values.extra ?? {})) {
    roles.add(extraRole(id));
  }
  return roles;
}

export function modeOptions(language, role = F.MODE) {
  const [keys, names] =
    role === F.DHW_MODE_SELECT ? [DHW_SELECTABLE, DHW_MODE_NAMES] : [SELECTABLE, MODE_NAMES];
  return keys.map((key, index) => ({
    value: key,
    label: word(names[key], language),
    sort_order: index,
  }));
}

const SELECTS = [F.MODE, F.HC2_MODE, F.DHW_MODE_SELECT];

/**
 * The Gladys device of the adapter. `roles`: those seen; `adapter`: what
 * /JI said (when read); `created`: the device already created in Gladys,
 * whose features are kept when the new build lacks them.
 */
export function buildDevice(
  gladys,
  mac,
  { roles, adapter, model, language, created, extras = {} },
) {
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
    features: [
      ...ROLES.filter((role) => roles.has(role)).map((role) => ({
        name: word(FEATURE_NAMES[role], language),
        external_id: ids.feature(role),
        ...definitionOf(role),
        ...(SELECTS.includes(role) ? { supported_options: modeOptions(language, role) } : {}),
      })),
      // The read-only parameters of the configuration, as first seen.
      ...Object.entries(extras)
        .filter(([id]) => roles.has(extraRole(id)))
        .map(([id, seen]) => ({
          name: extraName(id, seen),
          external_id: ids.feature(extraRole(id)),
          ...extraDefinitionOf(seen.kind),
        })),
    ],
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** "BSB 8326 Burner modulation (%)": the number, the controller's name, the unit of a plain number. */
function extraName(id, seen) {
  const unit = seen.kind === 'number' && seen.unit ? ` (${seen.unit})` : '';
  return `BSB ${id}${seen.name ? ` ${seen.name}` : ''}${unit}`.slice(0, 100);
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
export function deviceStates(ids, values, { status = 'online', bus, language, extraKinds = {} }) {
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
  if (values.mode2 !== undefined) {
    states.push({ role: F.HC2_MODE_STATE, text: modeText(values.mode2, MODE_NAMES, language) });
    if (SELECTABLE.includes(values.mode2.key)) {
      states.push({ role: F.HC2_MODE, text: values.mode2.key });
    }
  }
  for (const [role, valueOf] of Object.entries(TEXTS)) {
    const read = valueOf(values);
    if (read !== undefined) {
      const fallback = word(STATE_TEXTS.statusCode(read.code), language);
      states.push({
        role,
        text:
          role === F.LAST_FAULT_CODE && read.desc
            ? `${read.code} ${read.desc}`
            : (read.desc ?? fallback),
      });
    }
  }
  if (values.lastFaultDate !== undefined) {
    states.push({ role: F.LAST_FAULT_DATE, text: values.lastFaultDate });
  }
  if (values.dhwMode !== undefined) {
    states.push({ role: F.DHW_MODE, text: modeText(values.dhwMode, DHW_MODE_NAMES, language) });
    if (bus !== 'pps' && DHW_SELECTABLE.includes(values.dhwMode.key)) {
      states.push({ role: F.DHW_MODE_SELECT, text: values.dhwMode.key });
    }
  }
  // A read-only parameter is published only as the kind of its feature.
  for (const [id, read] of Object.entries(values.extra ?? {})) {
    if (extraKinds[id] !== read.kind) {
      continue;
    }
    states.push(
      read.kind === 'text'
        ? { role: extraRole(id), text: read.text }
        : { role: extraRole(id), state: read.value },
    );
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
