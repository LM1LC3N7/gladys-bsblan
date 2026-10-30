// -----------------------------------------------------------------------------
// Constants: feature roles, manifest keys, limits and timings.
//
// BSB-LAN is an open adapter (Arduino Due / ESP32 board) wired to the BSB,
// LPB or PPS bus of boilers and heat pumps with a Siemens controller (ELCO,
// Brötje, Baxi, MHG, Atlantic, Thision…). It serves a JSON API over plain
// HTTP on the local network, port 80 by default: /JI (adapter info), /JV
// (JSON-API version), /JQ (read parameters), /JS (write a parameter), as
// python-bsblan 6.1.10 uses it. A passkey (a path prefix) and HTTP basic
// authentication are both optional. The parameter map lives in src/params.js.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  MODE_STATE: 'operating-mode',
  HEATING_STATUS: 'heating-status',
  HEATING_SETPOINT: 'heating-setpoint',
  HEATING_SETPOINT_REDUCED: 'heating-setpoint-reduced',
  /** The room setpoint of a PPS bus, read only. */
  PPS_SETPOINT: 'room-setpoint',
  TEMP_ROOM: 'temperature-room',
  TEMP_OUTDOOR: 'temperature-outdoor',
  DHW_MODE: 'dhw-mode',
  DHW_SETPOINT: 'dhw-setpoint',
  DHW_SETPOINT_REDUCED: 'dhw-setpoint-reduced',
  TEMP_DHW: 'temperature-dhw',
  DHW_PUMP: 'dhw-pump',
  ENERGY_TOTAL: 'energy-total',
  // 0.2.0: heating circuit 1, more.
  /** 712, writable (`heating-setpoint-reduced` stays read only, on the devices that have it). */
  HEATING_REDUCED_TARGET: 'heating-reduced-target',
  FLOW_SETPOINT: 'flow-setpoint',
  TEMP_FLOW: 'temperature-flow',
  // Heating circuit 2 (1000 series), when the controller has it.
  HC2_MODE: 'hc2-mode',
  HC2_MODE_STATE: 'hc2-operating-mode',
  HC2_STATUS: 'hc2-status',
  HC2_SETPOINT: 'hc2-setpoint',
  HC2_REDUCED_TARGET: 'hc2-reduced-target',
  HC2_FLOW_SETPOINT: 'hc2-flow-setpoint',
  HC2_TEMP_FLOW: 'hc2-temperature-flow',
  // Hot water: the mode as a command, its status, 1612 writable.
  DHW_MODE_SELECT: 'dhw-mode-select',
  DHW_STATUS: 'dhw-status',
  /** 1612, writable (`dhw-setpoint-reduced` stays read only, on the devices that have it). */
  DHW_REDUCED_TARGET: 'dhw-reduced-target',
  // The boiler, read only.
  BOILER_STATUS: 'boiler-status',
  TEMP_BOILER: 'temperature-boiler',
  BURNER_STAGE_1: 'burner-stage-1',
  BURNER_FAULT: 'burner-fault-s3',
  LAST_FAULT_DATE: 'last-fault-date',
  LAST_FAULT_CODE: 'last-fault-code',
};

/** Read-only parameters typed in the configuration: role `param-<id>`. */
export const EXTRA_PREFIX = 'param-';
export const EXTRA_LIMIT = 10;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

/**
 * The hot water setpoint the commands may set, in °C (scalding risk). The
 * configuration chooses the ceiling between `min` and `max`, 65 °C by
 * default; nothing above 65 °C is ever sent, whatever the configuration or
 * the controller would accept. The controller's own nominal setpoint max
 * (1614), read before each command, still applies when it is lower.
 */
export const DHW_CAP = {
  min: 40,
  max: 65,
  default: 65,
};

/**
 * The hard bounds of the setpoints, whatever the controller says: the
 * heating comfort setpoint within 5–35 °C, the hot water one from 10 °C.
 * Inside them, a command is bounded by the range the controller reads now
 * (714–716 for heating, 1612–1614 for hot water).
 */
export const SETPOINT_LIMITS = {
  heating: { min: 5, max: 35 },
  dhw: { min: 10, max: DHW_CAP.max },
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** An answer of BSB-LAN is read up to this size, then dropped. */
  bodyBytes: 64 * 1024,
  /** Parameters per /JQ request: the adapter queries the bus one by one. */
  parametersPerRead: 4,
  /** Texts of the controller (status, mode names) are cut to this length. */
  textLength: 120,
  /** A read-only parameter typed in the configuration: plain numbers within ±this. */
  extraNumber: 1_000_000,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection to the adapter. */
  connectTimeout: 3 * SECOND,
  /** One request of the polling (the adapter queries the bus: a few seconds). */
  requestTimeout: 15 * SECOND,
  /** Failed polls: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** An HTTP 429 or 5xx: a pause of 1 min to 6 h, persisted in /data. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** Credentials refused (401/403): next tries 15 min, 1 h, 6 h, then every 24 h. */
  authRetry: [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  /** Firmware without a usable /JV, or no MAC address: read again every 30 minutes. */
  unsupportedRetry: 30 * MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the adapter at most this often. */
  testCooldown: 10 * SECOND,
  /** The button waits 30 s in Gladys: it answers by 25 s, the read going on if longer. */
  testBudget: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** After a write that may have left, the next command waits this long ("still running"). */
  commandSpacing: 3 * SECOND,
  /** Polls after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A protective command (Protection, hot water Off) not seen applied is written again, at most so often. */
  protectiveResends: 3,
  /** A protective command waits for a busy adapter this long at most (the ack goes at 3.5 s). */
  protectiveWait: 30 * SECOND,
};
