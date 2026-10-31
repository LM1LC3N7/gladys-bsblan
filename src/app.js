// -----------------------------------------------------------------------------
// The integration: the BSB-LAN adapter typed in the configuration (its IP
// address, an optional passkey and basic authentication), one read of its
// parameters every poll interval, the Gladys device of the adapter and its
// states, the transport badge, the "Test the connection" button, and the
// three commands (heating mode, comfort setpoint, hot water setpoint),
// refused unless the configuration allows them. index.js only wires the
// SDK handlers.
//
// Failures (lessons of the previous waves):
//   - credentials refused (HTTP 401/403): a stop persisted in /data, next
//     tries 15 min, 1 h, 6 h then every 24 h, never in a loop; saving other
//     credentials or "Test the connection" tries again;
//   - HTTP 429 or 5xx: a pause of 1 min to 6 h, persisted in /data, applied
//     to every path (polls, commands, the button);
//   - anything else: 30 s, 1, 2, 5 min, never sooner than the interval;
//   - a reconnection to Gladys clears none of them.
//
// The commands follow the rules learnt on the previous modules (as the
// sibling gladys-stiebel-eltron):
//   - decided on a fresh read of the parameters only, never on the values
//     kept in memory, and refused when a value or the allowed range of the
//     controller is missing;
//   - the "Allow the commands" option and the hot water ceiling are checked
//     on arrival, after the fresh read and right before the request leaves;
//   - the fresh read and the write hold the adapter together (the Gate): no
//     other request runs in between;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a write that may have reached the adapter (silence, a dropped
//     connection, a 5xx, an answer without a clear status) is never answered
//     "not sent": "sent, without confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time; never retried.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, connectionKey, normalizeConfig } from './config.js';
import {
  DHW_CAP,
  EXTRA_PREFIX,
  FEATURES as F,
  LIMITS,
  SECOND,
  SETPOINT_LIMITS,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  extraKindOf,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
} from './devices.js';
import { ERRORS, STATE_TEXTS, T, age, join, word } from './i18n.js';
import {
  DHW_MODES,
  DHW_MODE_CODES,
  DHW_SELECTABLE,
  HC2_REST,
  MODES,
  MODE_CODES,
  P,
  accessOf,
  POLL,
  SELECTABLE,
  adapterOf,
  enumerated,
  temperature,
  apiVersionOf,
  decode,
  identificationOf,
  writeAccess,
  writeOutcome,
} from './params.js';
import { BsbClient, departedOf } from './bsblan/client.js';
import { BsbError, CODES, isAuthRefused, isBusy, reasonOf } from './bsblan/errors.js';
import { StatePublisher } from './publisher.js';
import { memoryStore, normalizeMemory, serializeMemory } from './store.js';

const heating = (id, key, extra) => ({
  kind: 'heating',
  id,
  key,
  ...extra,
});

/**
 * The commands, by role: the parameter written, what the fresh read asks,
 * the decoded value it compares (src/params.js decode). `protective`: the
 * choice never held back (Protection, hot water Off).
 */
const COMMANDS = {
  [F.MODE]: {
    kind: 'mode',
    id: P.MODE,
    read: [P.MODE],
    key: 'mode',
    options: SELECTABLE,
    codes: MODE_CODES,
    names: MODES,
    protective: 'protection',
  },
  [F.HC2_MODE]: {
    kind: 'mode',
    id: P.MODE2,
    read: [P.MODE2],
    key: 'mode2',
    options: SELECTABLE,
    codes: MODE_CODES,
    names: MODES,
    protective: 'protection',
  },
  [F.DHW_MODE_SELECT]: {
    kind: 'mode',
    id: P.DHW_MODE,
    read: [P.DHW_MODE],
    key: 'dhwMode',
    options: DHW_SELECTABLE,
    codes: DHW_MODE_CODES,
    names: DHW_MODES,
    protective: 'off',
  },
  // Circuit 1: comfort 710 and reduced 712, within 714 and 716, reduced <= comfort.
  [F.HEATING_SETPOINT]: heating(P.COMFORT, 'heatingSetpoint', {
    read: [P.COMFORT, P.REDUCED, P.PROTECTIVE, P.COMFORT_MAX],
    bounds: ['heatingSetpoint', 'heatingSetpointReduced', 'heatingMin', 'heatingMax'],
  }),
  [F.HEATING_REDUCED_TARGET]: heating(P.REDUCED, 'heatingSetpointReduced', {
    reduced: true,
    read: [P.COMFORT, P.REDUCED, P.PROTECTIVE, P.COMFORT_MAX],
    bounds: ['heatingSetpoint', 'heatingSetpointReduced', 'heatingMin', 'heatingMax'],
  }),
  // Circuit 2: the same with 1010, 1012, 1014, 1016; its mode (1000) read too (it exists).
  [F.HC2_SETPOINT]: heating(P.COMFORT2, 'heating2Setpoint', {
    read: [P.MODE2, P.COMFORT2, P.REDUCED2, P.PROTECTIVE2, P.COMFORT_MAX2],
    bounds: ['heating2Setpoint', 'heating2SetpointReduced', 'heating2Min', 'heating2Max'],
  }),
  [F.HC2_REDUCED_TARGET]: heating(P.REDUCED2, 'heating2SetpointReduced', {
    reduced: true,
    read: [P.MODE2, P.COMFORT2, P.REDUCED2, P.PROTECTIVE2, P.COMFORT_MAX2],
    bounds: ['heating2Setpoint', 'heating2SetpointReduced', 'heating2Min', 'heating2Max'],
  }),
  // Hot water: nominal 1610 and reduced 1612, under 1614, the ceiling and 65 °C.
  [F.DHW_SETPOINT]: {
    kind: 'dhw',
    id: P.DHW_NOMINAL,
    key: 'dhwSetpoint',
    read: [P.DHW_NOMINAL, P.DHW_REDUCED, P.DHW_NOMINAL_MAX],
  },
  [F.DHW_REDUCED_TARGET]: {
    kind: 'dhw',
    id: P.DHW_REDUCED,
    key: 'dhwSetpointReduced',
    reduced: true,
    read: [P.DHW_NOMINAL, P.DHW_REDUCED, P.DHW_NOMINAL_MAX],
  },
};

/** The decoded values a read of one parameter gives (to refresh after a command's read). */
const ID_KEYS = {
  [P.MODE]: ['mode'],
  [P.COMFORT]: ['heatingSetpoint'],
  [P.REDUCED]: ['heatingSetpointReduced'],
  [P.PROTECTIVE]: ['heatingMin'],
  [P.COMFORT_MAX]: ['heatingMax'],
  [P.MODE2]: ['mode2', 'heating2Setpoint', 'heating2SetpointReduced', 'heating2Min', 'heating2Max'],
  [P.COMFORT2]: ['heating2Setpoint'],
  [P.REDUCED2]: ['heating2SetpointReduced'],
  [P.PROTECTIVE2]: ['heating2Min'],
  [P.COMFORT_MAX2]: ['heating2Max'],
  [P.DHW_MODE]: ['dhwMode'],
  [P.DHW_NOMINAL]: ['dhwSetpoint'],
  [P.DHW_REDUCED]: ['dhwSetpointReduced'],
  [P.DHW_NOMINAL_MAX]: ['dhwMax'],
};

const tenth = (value) => (value === undefined ? undefined : Math.round(value * 10));

/** What a command compares, for a role: the mode key or the setpoint in tenths of °C. */
function comparable(role, values) {
  const spec = COMMANDS[role];
  if (spec.kind === 'mode') {
    return values?.[spec.key]?.key;
  }
  return tenth(values?.[spec.key]);
}

/** The value one entry read back gives, for a role (the same scale as `comparable`). */
function readBack(spec, entry) {
  if (spec.kind === 'mode') {
    const read = enumerated(entry);
    return read && Object.hasOwn(spec.names, read.code) ? spec.names[read.code] : undefined;
  }
  return tenth(temperature(entry, 0, 95).value);
}

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
};

const unsupported = (kind) => Object.assign(new Error(kind), { unsupported: kind });

export class BsbLanApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'bsblan' }),
    request,
    store = memoryStore(),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    /** The HTTP transport (tests); node:http otherwise. */
    this.request = request;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.adapter = undefined;
    /** What survives a restart (src/store.js), loaded at the first start. */
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    this.saveWarned = false;
    /** mac -> the roles its values were seen to report (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** The command in flight (one at a time for the adapter). */
    this.inFlight = undefined;
    /** No new command before this time: a write left just before. */
    this.quietUntil = -Infinity;
    /** `${mac}:${role}` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** Increases at every read of parameters (a poll batch, a command's fresh read). */
    this.readSeq = 0;
    /** id -> { seq, entry }: the last fresh read of a command, per parameter. */
    this.freshReads = new Map();
    /** Increases at every protective command: a command that arrived before never leaves after. */
    this.stopEpoch = 0;
    /** `${mac}:${role}` of the kept stops being written now (never two at once). */
    this.stopFlight = new Set();
    this.stopTimer = undefined;
    /** Departure stamp of the last request (src/bsblan/client.js): orders reads and writes. */
    this.ioSeq = 0;
    /** Arrival number of the last command: a stop is lifted only by a command that came after it. */
    this.arrival = 0;
    /** `${mac}:${role}` that had a command this run: an old stop read from /data never overrides it. */
    this.touched = new Set();
    this.configTimer = undefined;
    this.configTries = 0;
    /** /data there but not readable: never overwritten, read again later. */
    this.memoryUnreadable = false;
    /** mac -> { id: { kind, name, unit } }: the read-only parameters of the configuration, as first seen. */
    this.extraSeen = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  freshAdapter(config) {
    return {
      address: config.address,
      client: new BsbClient({
        address: config.address,
        passkey: config.passkey,
        username: config.username,
        password: config.password,
        now: this.now,
        timers: this.timers,
        depart: () => ++this.ioSeq,
        ...(this.request ? { request: this.request } : {}),
      }),
      /** What /JI said last (src/params.js adapterOf), and the MAC of the last good read. */
      info: undefined,
      mac: undefined,
      apiVersion: undefined,
      /** The controller identification (6224). */
      model: undefined,
      online: undefined,
      failures: 0,
      wait: undefined,
      /** 'auth', 'busy', 'version', 'noMac', or a short reason. */
      error: undefined,
      status: undefined,
      /** The values of the last read (src/params.js decode). */
      values: undefined,
      /** Heating circuit 2: true, false (its mode 1000 missing), undefined before a read. */
      hc2: undefined,
      /** The MAC of the last /JI (a kept stop is written only to its own adapter). */
      lastMac: undefined,
      timer: undefined,
      running: undefined,
      followUps: new Set(),
    };
  }

  /** A promise of /data, never awaited longer than TIMINGS.dataWait ('late' then). */
  bounded(promise) {
    let handle;
    const late = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve('late'), TIMINGS.dataWait);
    });
    return Promise.race([promise, late]).finally(() => this.timers.clearTimeout(handle));
  }

  async loadMemory() {
    if (this.memoryLoaded) {
      return;
    }
    this.memoryLoaded = true;
    await this.reloadMemory();
  }

  /**
   * Reads /data (bounded). Missing: empty. Unreadable or too slow: NOT empty;
   * `memoryUnreadable` keeps every save off (never overwritten) and the read
   * is tried again later. What it holds is merged with what this run keeps.
   * Returns true when read.
   */
  async reloadMemory() {
    let raw;
    try {
      raw = await this.bounded(this.store.load());
    } catch {
      raw = 'late';
    }
    if (raw === 'late') {
      if (!this.memoryUnreadable) {
        this.logger.warn('The state in /data could not be read: kept as it is, read again later');
      }
      this.memoryUnreadable = true;
      return false;
    }
    const read = normalizeMemory(raw, this.now());
    const mine = this.memory;
    this.memory = {
      pausedUntil: Math.max(read.pausedUntil, mine.pausedUntil),
      auth: read.auth.until >= mine.auth.until ? read.auth : mine.auth,
      // An old stop never overrides a command of its role made in this run.
      stops: [
        ...mine.stops,
        ...read.stops.filter(
          (k) =>
            !mine.stops.some((m) => m.mac === k.mac && m.role === k.role) &&
            !this.touched.has(`${k.mac}:${k.role}`),
        ),
      ],
    };
    this.memoryUnreadable = false;
    if (this.memory.stops.length > 0) {
      this.armStopCheck(0);
    }
    if (
      read.stops.some((k) => !this.memory.stops.some((m) => m.mac === k.mac && m.role === k.role))
    ) {
      // An old stop set aside (a newer command of its role this run): gone from /data too.
      void this.saveMemory();
    }
    return true;
  }

  /** Bounded: a slow or frozen /data never holds the caller (nor a stop). */
  saveMemory() {
    const attempt = (async () => {
      if (this.memoryUnreadable && !(await this.reloadMemory())) {
        return;
      }
      await this.store.save(serializeMemory(this.memory));
    })().catch((err) => {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`The state could not be saved in /data: ${err?.code ?? 'error'}`);
      }
    });
    return this.bounded(attempt);
  }

  async start(raw = {}) {
    const previous = this.adapter;
    this.stop();
    await previous?.running;
    await this.loadMemory();
    this.config = normalizeConfig(raw);
    this.adapter = this.config.address ? this.freshAdapter(this.config) : undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.adapter) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    // The stops kept in /data leave first, before any read.
    this.flushStops({ atStart: true });
    await this.setStatus(false, T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    if (this.stopTimer !== undefined) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    this.stopFlight.clear();
    if (this.adapter) {
      this.clearTimer();
      for (const handle of this.adapter.followUps) {
        this.timers.clearTimeout(handle);
      }
      this.adapter.followUps.clear();
      this.adapter.client.close();
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.adapter?.timer) {
      this.timers.clearTimeout(this.adapter.timer);
      this.adapter.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges) and the last states. The client, the pause and the stop on
   * refused credentials stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.configUpdated(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  /**
   * Connected to Gladys, its configuration to read first. A failure of
   * getConfig() is said in the status and tried again, spaced (5 s, 15 s,
   * 30 s, 1 min, then every 5 min), never given up; a new connection
   * restarts the tries.
   */
  async connectedWith(getConfig) {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch {
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `The configuration could not be read: next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configNotRead(age(wait)));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Start failed'));
      }, wait);
      return;
    }
    this.configTries = 0;
    await this.connected(raw);
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      connectionKey(next) !== connectionKey(this.config)
    );
  }

  /**
   * Saved by the user. Other credentials (or another adapter) lift the stop
   * on refused credentials; another address also lifts the pause. The
   * option, the ceiling and the language apply at once.
   */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== connectionKey(this.config)) {
      const otherAddress =
        JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null);
      this.memory.auth = { failures: 0, until: 0 };
      if (otherAddress) {
        this.memory.pausedUntil = 0;
      }
      await this.saveMemory();
      await this.start(raw);
      return;
    }
    if (next.pollInterval !== this.config.pollInterval) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (next.allowCommands !== previous.allowCommands) {
      this.logger.info(`BSB-LAN commands ${next.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`setConnectionStatus failed: ${err.message}`);
    });
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The end of a pause (429/5xx) or of the stop on refused credentials, else 0. */
  blockedUntil() {
    const until = Math.max(this.memory.pausedUntil, this.memory.auth.until);
    return until > this.now() ? until : 0;
  }

  /** The next read: after a backoff when the last one failed, else the interval. */
  schedule() {
    const adapter = this.adapter;
    this.clearTimer();
    const base = adapter.online === false ? (adapter.wait ?? this.interval) : this.interval;
    const blocked = this.blockedUntil() - this.now();
    const wait = Math.max(base, blocked, 0);
    const generation = this.generation;
    adapter.timer = this.timers.setTimeout(() => {
      adapter.timer = undefined;
      if (generation === this.generation) {
        this.tick({ periodic: true }).catch(() => this.logger.error('BSB-LAN refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the user asked. */
  tick({ force = false, periodic = false } = {}) {
    const adapter = this.adapter;
    if (!adapter) {
      return Promise.resolve();
    }
    if (!adapter.running) {
      adapter.running = this.run(adapter, { force, periodic }).finally(() => {
        adapter.running = undefined;
      });
    }
    return adapter.running;
  }

  async run(adapter, { force, periodic }) {
    const generation = this.generation;
    if (this.memoryUnreadable) {
      await this.reloadMemory();
    }
    const now = this.now();
    if (this.memory.pausedUntil > now) {
      this.halted(adapter, 'busy', this.memory.pausedUntil - now);
    } else if (this.memory.auth.until > now && !force) {
      this.halted(adapter, 'auth', this.memory.auth.until - now);
    } else {
      try {
        await this.read(adapter, generation, { periodic });
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        this.failed(adapter, err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /** Nothing requested: a pause or a stop holds. */
  halted(adapter, error, wait) {
    adapter.online = false;
    if (adapter.error !== error) {
      // The HTTP status that caused it (a 403) stays while the same stop holds.
      adapter.status = undefined;
    }
    adapter.error = error;
    adapter.wait = wait;
  }

  async read(adapter, generation, { periodic = false } = {}) {
    const { client } = adapter;
    const info = adapterOf(await client.info());
    // The MAC that answers at the address now, before anything else is read.
    adapter.lastMac = info?.mac;
    if (!info?.mac) {
      throw unsupported('noMac');
    }
    if (adapter.mac && adapter.mac !== info.mac) {
      // Another adapter answers at this address: what was read of the first one is dropped.
      this.logger.warn('BSB-LAN: another adapter answers at this address');
      adapter.values = undefined;
      adapter.apiVersion = undefined;
      adapter.model = undefined;
      adapter.mac = undefined;
      this.freshReads.clear();
    }
    if (adapter.apiVersion === undefined) {
      let version;
      try {
        version = apiVersionOf(await client.apiVersion());
      } catch (err) {
        // No /JV (older firmware): not supported, as python-bsblan; a passing failure otherwise.
        if (!((err.code === CODES.HTTP && err.status === 404) || err.code === CODES.BAD_ANSWER)) {
          throw err;
        }
      }
      if (!version) {
        throw unsupported('version');
      }
      adapter.apiVersion = version;
    }
    const ids = [...POLL[info.bus]];
    if (info.bus === 'bsb' && adapter.hc2 !== false) {
      // Circuit 2: its other parameters while its mode (1000) is not known missing.
      ids.push(...HC2_REST);
    }
    if (info.bus === 'bsb' && !adapter.model) {
      ids.push(P.IDENTIFICATION);
    }
    // The read-only parameters typed in the configuration, last.
    const extras = this.config.extraParams.filter((id) => !ids.includes(id));
    ids.push(...extras);
    // A few parameters per request: the Gate frees between them, so a
    // command never waits for a whole poll.
    const merged = {};
    /** id -> the sequence number of the batch that read it. */
    const readAt = new Map();
    /** id -> the departure stamp of the request that read it. */
    const stamps = {};
    for (const batch of chunks(ids, LIMITS.parametersPerRead)) {
      const answer = await client.query(batch);
      if (generation !== this.generation) {
        return;
      }
      const seq = ++this.readSeq;
      for (const id of batch) {
        readAt.set(id, seq);
        stamps[id] = departedOf(answer);
        if (Object.hasOwn(answer, id)) {
          merged[id] = answer[id];
        }
      }
    }
    // A command re-read a parameter after the batch of this poll that read
    // it (the Gate lets a command pass between two batches): the command's
    // read is newer and replaces that parameter only. A batch read after
    // the command (its write included) is newer and stays.
    if (adapter.mac === info.mac) {
      for (const [id, fresh] of this.freshReads) {
        if (readAt.has(id) && fresh.seq > readAt.get(id)) {
          stamps[id] = fresh.stamp;
          if (fresh.entry === undefined) {
            delete merged[id];
          } else {
            merged[id] = fresh.entry;
          }
        }
      }
    }
    const values = decode(info.bus, merged, extras);
    adapter.hc2 = info.bus === 'bsb' ? values.mode2 !== undefined : false;
    this.rememberExtras(info.mac, values.extra);
    adapter.model ??= identificationOf(merged);
    adapter.info = info;
    adapter.mac = info.mac;
    adapter.values = values;
    adapter.online = true;
    adapter.failures = 0;
    adapter.wait = undefined;
    adapter.error = undefined;
    adapter.status = undefined;
    if (this.memory.auth.failures > 0 || this.memory.auth.until > 0) {
      this.memory.auth = { failures: 0, until: 0 };
      await this.saveMemory();
    }
    this.observe(info.mac, values, { stamps, periodic });
    // The stops of this adapter not sent yet, or kept from before a restart
    // (held until its MAC was read): now.
    if (this.memory.stops.some((k) => k.mac === info.mac && (k.sent === 0 || k.restart))) {
      this.armStopCheck(0);
    }
  }

  /**
   * A refusal of the credentials or a 429/5xx, met by any request: the stop
   * or the pause, persisted. Returns the wait, or undefined for any other error.
   */
  block(err) {
    const now = this.now();
    if (isAuthRefused(err)) {
      const { failures } = this.memory.auth;
      const wait = TIMINGS.authRetry[Math.min(failures, TIMINGS.authRetry.length - 1)];
      this.memory.auth = { failures: failures + 1, until: now + wait };
      void this.saveMemory();
      this.logger.warn(
        `BSB-LAN refused the credentials (HTTP ${err.status}): next try in ${Math.round(wait / 60_000)} min`,
      );
      return { kind: 'auth', wait };
    }
    if (isBusy(err)) {
      const step =
        TIMINGS.backoff[Math.min(this.adapter?.failures ?? 0, TIMINGS.backoff.length - 1)];
      const wait = Math.min(
        TIMINGS.pauseMax,
        Math.max(TIMINGS.pauseMin, this.interval, err.retryAfterMs ?? step),
      );
      this.memory.pausedUntil = Math.max(this.memory.pausedUntil, now + wait);
      void this.saveMemory();
      this.logger.warn(
        `BSB-LAN busy (HTTP ${err.status}): paused for ${Math.round(wait / 1000)} s`,
      );
      return { kind: 'busy', wait };
    }
    return undefined;
  }

  failed(adapter, err) {
    adapter.online = false;
    adapter.status = undefined;
    if (err.unsupported) {
      adapter.error = err.unsupported;
      adapter.wait = Math.max(this.interval, TIMINGS.unsupportedRetry);
      this.logger.warn(`BSB-LAN: ${err.unsupported === 'noMac' ? 'no MAC address' : 'no /JV'}`);
      return;
    }
    const blocked = this.block(err);
    if (blocked) {
      adapter.error = blocked.kind;
      adapter.wait = blocked.wait;
      adapter.status = err.status;
      adapter.failures += 1;
      return;
    }
    const reason = reasonOf(err);
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(adapter.failures, TIMINGS.backoff.length - 1)],
    );
    adapter.failures += 1;
    adapter.wait = wait;
    adapter.error = reason;
    adapter.status = err.status;
    this.logger.warn(
      `BSB-LAN ${addressKey(adapter.address)}: ${reason}; next try in ${Math.round(wait / 1000)} s`,
    );
  }

  // --- What the adapter gives -------------------------------------------------

  /** Whether the values of the last read are current. */
  get live() {
    return Boolean(this.adapter?.online === true && this.adapter.mac && this.adapter.values);
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, mac }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const mac = parseDeviceId(device?.external_id);
      if (mac && deviceIds(this.gladys, mac).device === device.external_id) {
        list.push({ device, mac });
      }
    }
    return list;
  }

  /**
   * How a created device stands: 'online', 'offline' (the adapter does not
   * answer) or 'other' (another adapter answers). undefined while a first
   * read is under way.
   */
  standing(mac) {
    if (this.live) {
      return mac === this.adapter.mac ? 'online' : 'other';
    }
    if (!this.adapter || this.adapter.online === false) {
      return 'offline';
    }
    return undefined;
  }

  /** The roles of an adapter: those seen during this run, plus those the last read reports. */
  rolesFor(mac) {
    const seen = this.seen.get(mac) ?? new Set();
    if (this.live && mac === this.adapter.mac) {
      for (const role of reportedRoles(this.adapter.values, this.adapter.info.bus)) {
        seen.add(role);
      }
    }
    this.seen.set(mac, seen);
    return seen;
  }

  /** The kind, name and unit of each read-only parameter, fixed at its first value. */
  rememberExtras(mac, extra) {
    const seen = this.extraSeen.get(mac) ?? {};
    for (const [id, read] of Object.entries(extra ?? {})) {
      if (!Object.hasOwn(seen, id)) {
        seen[id] = { kind: read.kind, name: read.name, unit: read.unit };
      }
    }
    this.extraSeen.set(mac, seen);
  }

  /** id -> kind of the read-only parameters: the created feature's, else the first value's. */
  extraKinds(mac) {
    const kinds = {};
    for (const [id, seen] of Object.entries(this.extraSeen.get(mac) ?? {})) {
      kinds[id] = seen.kind;
    }
    const ids = deviceIds(this.gladys, mac);
    for (const f of this.createdDevice(ids.device)?.features ?? []) {
      const parsed = parseFeatureId(f?.external_id);
      if (parsed?.role.startsWith(EXTRA_PREFIX)) {
        const kind = extraKindOf(f);
        const id = parsed.role.slice(EXTRA_PREFIX.length);
        if (kind) {
          kinds[id] = kind;
        } else {
          delete kinds[id];
        }
      }
    }
    return kinds;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery list: the device of the adapter last read (even
   * unreachable now); before any read, the devices already created, as they are.
   */
  async publishDevices() {
    const macs = this.adapter?.mac
      ? [this.adapter.mac]
      : [...new Set(this.ourDevices().map((entry) => entry.mac))];
    const devices = macs
      .map((mac) =>
        buildDevice(this.gladys, mac, {
          roles: this.rolesFor(mac),
          adapter: mac === this.adapter?.mac ? this.adapter.info : undefined,
          model: mac === this.adapter?.mac ? this.adapter.model : undefined,
          language: this.config.language,
          created: this.createdDevice(deviceIds(this.gladys, mac).device),
          extras: this.extraSeen.get(mac) ?? {},
        }),
      )
      // Never a device without a feature (a controller that gave no value).
      .filter((d) => d.features.length > 0);
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const { mac } of this.ourDevices()) {
      const status = this.standing(mac);
      if (status === undefined) {
        continue;
      }
      const ids = deviceIds(this.gladys, mac);
      const online = status === 'online';
      const states = deviceStates(ids, online ? this.adapter.values : {}, {
        status,
        bus: online ? this.adapter.info.bus : undefined,
        language: this.config.language,
        extraKinds: this.extraKinds(mac),
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    for (const { device, mac } of this.ourDevices()) {
      const status = this.standing(mac);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport: status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message] = this.status();
    // Where the kept stops stand, whatever the rest says.
    const held = this.memory.stops.filter(
      (k) => this.adapter?.mac && this.adapter.mac !== k.mac,
    ).length;
    const mine = this.memory.stops.filter(
      (k) => !(this.adapter?.mac && this.adapter.mac !== k.mac),
    );
    const waiting = mine.filter((k) => k.sent === 0).length;
    const unconfirmed = mine.length - waiting;
    const notes = [
      ...(waiting > 0 ? [T.notes.stopWaiting(waiting)] : []),
      ...(unconfirmed > 0 ? [T.notes.stopUnconfirmed(unconfirmed)] : []),
      ...(held > 0 ? [T.notes.stopOtherAdapter(held)] : []),
    ];
    await this.setStatus(connected, notes.length > 0 ? join2(message, join(notes)) : message);
  }

  status() {
    const adapter = this.adapter;
    if (!adapter) {
      return [false, T.problem(this.config.problem ?? 'empty', this.config.invalid)];
    }
    if (adapter.online === false) {
      const wait = age(adapter.wait ?? this.interval);
      switch (adapter.error) {
        case 'auth':
          if (adapter.status === 403) {
            return [false, T.forbidden(wait)];
          }
          return [false, this.config.username ? T.authRefused(wait) : T.authNeeded(wait)];
        case 'busy':
          return [false, T.busy(wait)];
        case 'version':
          return [false, T.unsupportedVersion(wait)];
        case 'noMac':
          return [false, T.noMac(wait)];
        default:
          return adapter.status === 404
            ? [false, T.notFound(addressKey(adapter.address), wait)]
            : [false, T.unreachable(addressKey(adapter.address), adapter.error, wait)];
      }
    }
    if (!this.live) {
      return [false, T.connecting];
    }
    const notes = [];
    if (adapter.values.fahrenheit) {
      notes.push(T.notes.fahrenheit);
    }
    if (adapter.info.bus === 'pps') {
      notes.push(T.notes.pps);
    } else if (!adapter.info.commandBus) {
      notes.push(T.notes.unknownBus);
    } else {
      // The access BSB-LAN gives the heating mode (700) in the last read,
      // else what /JI says of the bus (never believed before 5.1.19).
      const access = writeAccess(adapter.values.access?.[P.MODE], adapter.info);
      if (access === 'readOnlyParam' || access === 'readOnlyBus') {
        notes.push(T.notes.readOnlyBus);
      } else if (access === 'unknown') {
        notes.push(T.notes.unknownWrite);
      }
    }
    const created = this.ourDevices();
    if (created.length > 0 && !created.some((entry) => entry.mac === adapter.mac)) {
      notes.push(T.notes.otherAdapter);
    }
    if (this.config.extraIgnored.length > 0) {
      notes.push(T.notes.extraIgnored(this.config.extraIgnored));
    }
    return [
      true,
      T.connected(
        { model: adapter.model, bus: adapter.info.busName, version: adapter.info.version },
        notes,
      ),
    ];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /** Reads now (even after refused credentials: the user asked), at most every 10 s. */
  async testConnection() {
    if (!this.adapter) {
      return this.status()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join2(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A pause (429/5xx) holds even for the button; a read in progress is
    // joined. Gladys waits 30 s for the button: the answer comes by 25 s.
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMINGS.testBudget);
    });
    await Promise.race([this.tick({ force: true }), limit]);
    this.timers.clearTimeout(handle);
    // The user asked: the kept stops go too, even after refused credentials.
    if (this.live) {
      this.flushStops({ force: true });
    }
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, checked strictly (null, '' or 'abc' are not a
   * number; a mode is one of the exact keys of its list), within the hard
   * limits. Returns `{ id, text, value, key?, protective? }`.
   */
  parseCommand(role, value) {
    const spec = COMMANDS[role];
    if (spec.kind === 'mode') {
      if (typeof value !== 'string' || !spec.options.includes(value)) {
        throw this.refusal(ERRORS.badMode);
      }
      return {
        id: spec.id,
        text: String(spec.codes[value]),
        value,
        key: value,
        protective: value === spec.protective,
      };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (spec.kind === 'heating') {
      const { min, max } = SETPOINT_LIMITS.heating;
      if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
        throw this.refusal(ERRORS.badStep(0.1));
      }
      if (number < min || number > max) {
        throw this.refusal(ERRORS.outOfRange(min, max));
      }
      const rounded = Math.round(number * 10) / 10;
      return { id: spec.id, text: rounded.toFixed(1), value: rounded };
    }
    // A hot water setpoint: whole degrees, never above the hard ceiling nor
    // the configured one.
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badStep(1));
    }
    const { min, max } = SETPOINT_LIMITS.dhw;
    if (number < min || number > max) {
      throw this.refusal(ERRORS.outOfRange(min, max));
    }
    if (number > this.config.dhwCap) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
    return { id: spec.id, text: String(number), value: number };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target.role, value);
    // The order of the commands is the order of their arrival, never of their answers.
    const arrival = ++this.arrival;
    this.touched.add(`${target.mac}:${target.role}`);
    if (wanted.protective) {
      // Protection (frost protection) and hot water Off: never held back.
      return this.protect(target, wanted, received, { arrival });
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight || received < this.quietUntil) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, wanted, received, this.stopEpoch, arrival);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The checks before sending, on the latest configuration and state. */
  checkBeforeSend(generation, { mac, role }, wanted, epoch) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    // A protective command arrived since: this one never leaves after it.
    if (epoch !== this.stopEpoch) {
      throw this.refusal(ERRORS.overtaken);
    }
    if (this.blockedUntil() > 0) {
      throw this.refusal(ERRORS.paused);
    }
    if (generation !== this.generation || !this.live || mac !== this.adapter.mac) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    this.checkAdapter(this.adapter.info);
    // The ceiling may have been lowered since the command arrived.
    if (
      COMMANDS[role].kind === 'dhw' &&
      (wanted.value > this.config.dhwCap || wanted.value > DHW_CAP.max)
    ) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  /** The bus of an adapter (/JI) allows a command. */
  checkAdapter(info) {
    if (info.bus === 'pps') {
      throw this.refusal(ERRORS.pps);
    }
    if (!info.commandBus) {
      throw this.refusal(ERRORS.unknownBus);
    }
  }

  /**
   * The parameter may be written: its own access in the fresh read (BSB-LAN
   * folds its write setting into it), else what /JI says of the bus.
   */
  checkWriteAccess(entry, info) {
    switch (writeAccess(accessOf(entry), info)) {
      case 'yes':
        return;
      case 'readOnlyParam':
        throw this.refusal(ERRORS.readOnlyParam);
      case 'readOnlyBus':
        throw this.refusal(ERRORS.readOnlyBus);
      default:
        throw this.refusal(ERRORS.unknownWrite);
    }
  }

  async command(target, wanted, received, epoch, arrival) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, target, wanted, epoch);
    const adapter = this.adapter;
    const readBy = Math.min(this.now() + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // One session holds the adapter from the fresh read to the end of the
    // write: no other request runs in between. Still waiting at
    // readBy - minRead (a slow poll request in flight): refused unsent.
    try {
      return await adapter.client.session(
        (raw) =>
          this.commandSession(raw, target, wanted, {
            generation,
            adapter,
            received,
            sendBy,
            readBy,
            epoch,
            arrival,
          }),
        { startBy: readBy - TIMINGS.commandMinRead },
      );
    } catch (err) {
      if (err.code === CODES.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.code === CODES.CLOSED) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      throw err;
    }
  }

  /** Keeps what a command's read gave: the values, the access, the sequence (src/app.js read). */
  keepFresh(adapter, mac, ids, picked, stamp) {
    const fresh = decode('bsb', picked);
    for (const id of ids) {
      for (const key of ID_KEYS[id] ?? []) {
        adapter.values[key] = fresh[key];
      }
    }
    adapter.values.access = { ...adapter.values.access };
    for (const id of ids) {
      if (fresh.access[id] === undefined) {
        delete adapter.values.access[id];
      } else {
        adapter.values.access[id] = fresh.access[id];
      }
    }
    const seq = ++this.readSeq;
    for (const id of ids) {
      this.freshReads.set(id, { seq, entry: picked[id], stamp });
    }
    this.observe(mac, adapter.values, {
      stamps: Object.fromEntries(ids.map((id) => [id, stamp])),
    });
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    return fresh;
  }

  /** The command inside its session (the Gate is held: `raw` requests). */
  async commandSession(
    raw,
    target,
    wanted,
    { generation, adapter, received, sendBy, readBy, epoch, arrival },
  ) {
    const { mac, role } = target;
    const spec = COMMANDS[role];
    // First /JI, read now: the adapter answering at this address is the one
    // of the device (its MAC), on a BSB or LPB bus. Then the parameters,
    // never the values in memory. Both within the read budget.
    const ids = spec.read;
    let answer;
    try {
      const info = adapterOf(await raw.info({ answerBy: readBy }));
      adapter.lastMac = info?.mac;
      if (!info?.mac || info.mac !== mac) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (generation !== this.generation || this.adapter !== adapter || !this.live) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      // What /JI says now is what the status shows.
      adapter.info = info;
      this.checkAdapter(info);
      answer = await raw.query(ids, { answerBy: readBy });
    } catch (err) {
      if (!(err instanceof BsbError)) {
        throw err;
      }
      if (err.code === CODES.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      this.block(err);
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    if (generation !== this.generation || this.adapter !== adapter || !this.live) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const picked = {};
    for (const id of ids) {
      if (Object.hasOwn(answer, id)) {
        picked[id] = answer[id];
      }
    }
    const fresh = this.keepFresh(adapter, mac, ids, picked, departedOf(answer));

    this.checkRange(role, wanted, fresh);
    // Read only (the parameter, or the whole bus): refused before anything leaves.
    this.checkWriteAccess(picked[wanted.id], adapter.info);
    const current = comparable(role, fresh);
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const expected = spec.kind === 'mode' ? wanted.key : tenth(wanted.value);
    const key = `${mac}:${role}`;
    if (current === expected && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, target, wanted, epoch);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    await this.writeAndConfirm(raw, target, wanted, {
      plan: { from: current, expected },
      received,
      sendBy,
      arrival,
      // The very last check, right before the request leaves.
      beforeSend: () => this.checkBeforeSend(generation, target, wanted, epoch),
    });
  }

  /**
   * The write, then a read of the same parameter: success only when that
   * read shows the value asked. Equal to the value before: "not applied
   * yet"; not read in time: "sent, without confirmation".
   */
  async writeAndConfirm(
    raw,
    target,
    wanted,
    { plan, received, sendBy, beforeSend, protective, arrival },
  ) {
    const { mac, role } = target;
    const spec = COMMANDS[role];
    const key = `${mac}:${role}`;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The stamp this write takes when it leaves (requests leave one at a time).
    const writeStamp = this.ioSeq + 1;
    // The write left and was not refused: a kept stop counts a try; a
    // command that ARRIVED after a stop lifts it (never one that arrived
    // before, whenever its answer comes).
    const left = () =>
      protective ? this.stopSent(mac, role, writeStamp) : this.liftStopsBefore(mac, role, arrival);
    this.logger.info(`BSB-LAN ${role}: ${wanted.value}`);
    let written;
    try {
      written = await raw.set(wanted.id, wanted.text, { startBy: sendBy, answerBy, beforeSend });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      this.logger.warn(`BSB-LAN ${role}: ${wanted.value} failed (${reason})`);
      if (!err.sent) {
        // Nothing reached the adapter.
        throw this.refusal(err.code === CODES.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.code === CODES.HTTP && err.status >= 400 && err.status <= 499) {
        // Refused before the controller saw it (credentials, passkey, busy): not applied.
        this.block(err);
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection, a 5xx, an answer that is not JSON:
      // the write may have reached the controller.
      this.block(err);
      this.guard(key, plan);
      left();
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    const outcome = writeOutcome(written, wanted.id);
    if (outcome === 'refused') {
      if (protective) {
        // It left and BSB-LAN answered: a try (read only on the controller).
        this.stopSent(mac, role, writeStamp);
      }
      this.followUp();
      throw this.refusal(ERRORS.refused('BSB-LAN status 2'));
    }
    this.guard(key, plan);
    left();
    this.followUp();
    if (outcome !== 'ok') {
      throw this.refusal(ERRORS.sentUnconfirmed('no status 1'));
    }
    // Read back, in what is left of the answer budget.
    if (answerBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.sentUnconfirmed('not read back in time'));
    }
    let seen;
    try {
      const again = await raw.query([wanted.id], { answerBy });
      const entry = Object.hasOwn(again, wanted.id) ? again[wanted.id] : undefined;
      seen = readBack(spec, entry);
      const adapter = this.adapter;
      if (seen !== undefined && adapter?.values && adapter.mac === mac) {
        const seq = ++this.readSeq;
        const stamp = departedOf(again);
        this.freshReads.set(wanted.id, { seq, entry, stamp });
        adapter.values[spec.key] =
          spec.kind === 'mode'
            ? { code: spec.codes[seen], key: seen }
            : temperature(entry, 0, 95).value;
        // Its own read back never writes it again (only a later read does).
        this.observe(mac, adapter.values, { stamps: { [wanted.id]: stamp }, confirm: true });
        this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      }
    } catch (err) {
      if (!(err instanceof BsbError)) {
        throw err;
      }
      this.block(err);
      throw this.refusal(ERRORS.sentUnconfirmed(`not read back: ${reasonOf(err)}`));
    }
    if (seen === plan.expected) {
      return;
    }
    if (seen !== undefined && seen === plan.from) {
      throw this.refusal(ERRORS.notApplied);
    }
    throw this.refusal(ERRORS.sentUnconfirmed('not read back'));
  }

  /**
   * Protection (frost protection, 700 or 1000 = 0) or hot water Off
   * (1600 = 0): never held back by the option, a pause, refused
   * credentials, another command, a missing or old read, the range. It
   * passes before every queued request and cancels the commands not sent
   * yet; it waits only for the request the adapter is serving (BSB-LAN
   * serves one at a time: cutting ours would not free it sooner). Written
   * without a fresh read; refused only when it cannot leave: no adapter
   * configured, a PPS bus, another adapter read at the address, or BSB-LAN
   * busy past the budget (then sent as soon as it is free, within 30 s).
   */
  async protect(target, wanted, received, { kept = false, arrival = 0 } = {}) {
    const adapter = this.adapter;
    if (!adapter) {
      throw this.refusal(ERRORS.noAdapter);
    }
    if (adapter.info?.bus === 'pps') {
      throw this.refusal(ERRORS.pps);
    }
    if (adapter.mac && adapter.mac !== target.mac) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const generation = this.generation;
    const { mac, role } = target;
    const key = `${mac}:${role}`;
    if (!kept) {
      // A click: cancels what arrived before it, and is kept (in /data,
      // never awaited) until a read that left after it shows it applied.
      this.stopEpoch += 1;
      this.keepStop(mac, role, arrival);
    }
    const stop = this.stopOf(mac, role);
    if (!stop || !this.canSendStop(stop)) {
      // Kept for its own adapter: never written to another one.
      throw this.refusal(ERRORS.stopHeld);
    }
    // Only for the guard of a later command ("already so"), never for the stop.
    const from = comparable(role, adapter.values);
    this.stopFlight.add(key);
    const queuedAt = this.now();
    const session = adapter.client.session(
      (raw) => {
        // Late (BSB-LAN busy): its own budget, from now.
        const base =
          this.now() > received + TIMINGS.commandSendBy - TIMINGS.commandMinSend
            ? this.now()
            : received;
        return this.writeAndConfirm(raw, target, wanted, {
          plan: { from, expected: wanted.key },
          received: base,
          sendBy: base + TIMINGS.commandSendBy,
          protective: true,
          beforeSend: () => {
            if (generation !== this.generation || this.adapter !== adapter) {
              throw this.refusal(ERRORS.unknownDevice);
            }
            // Lifted while queued (a newer command left, another mode read
            // twice, or seen applied): not written; never to another adapter.
            const now = this.stopOf(mac, role);
            if (!now) {
              throw this.refusal(ERRORS.stopLifted);
            }
            if (!this.canSendStop(now)) {
              throw this.refusal(ERRORS.stopHeld);
            }
          },
        });
      },
      { urgent: true, startBy: queuedAt + TIMINGS.protectiveWait },
    );
    session.then(
      () => this.stopFlight.delete(key),
      () => this.stopFlight.delete(key),
    );
    const mapped = session.catch((err) => {
      if (err.code === CODES.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.code === CODES.CLOSED) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      throw err;
    });
    if (kept) {
      return mapped;
    }
    // The ack never waits past the budget: still queued then, it goes on.
    let handle;
    const late = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve('late'),
        Math.max(0, received + TIMINGS.commandSendBy - TIMINGS.commandMinSend - this.now()),
      );
    });
    const first = await Promise.race([
      mapped.then(
        () => 'done',
        () => 'done',
      ),
      late,
    ]);
    this.timers.clearTimeout(handle);
    if (first === 'late') {
      mapped.catch((err) =>
        this.logger.warn(`BSB-LAN ${role} ${wanted.value} (queued): ${err.message}`),
      );
      throw this.refusal(ERRORS.protectiveQueued);
    }
    return mapped;
  }

  /** The range of the controller, read just now (never the values in memory). */
  checkRange(role, wanted, fresh) {
    const spec = COMMANDS[role];
    if (spec.kind === 'mode') {
      const mode = fresh[spec.key];
      if (mode === undefined) {
        throw this.refusal(ERRORS.missingValue);
      }
      if (!mode.key) {
        throw this.refusal(ERRORS.protectedMode(STATE_TEXTS.unknownMode(mode.code)));
      }
      return;
    }
    if (spec.kind === 'heating') {
      const [comfort, reduced, min, max] = spec.bounds.map((key) => fresh[key]);
      if ([comfort, reduced, min, max].includes(undefined)) {
        throw this.refusal(ERRORS.missingValue);
      }
      // Comfort: never below the reduced setpoint nor the protection one.
      // Reduced: never below the protection one, never above the comfort one.
      const low = Math.max(SETPOINT_LIMITS.heating.min, min, spec.reduced ? -Infinity : reduced);
      const high = Math.min(SETPOINT_LIMITS.heating.max, max, spec.reduced ? comfort : Infinity);
      if (low > high) {
        throw this.refusal(ERRORS.missingValue);
      }
      if (wanted.value < low || wanted.value > high) {
        throw this.refusal(ERRORS.outOfDeviceRange(low, high));
      }
      return;
    }
    const { dhwSetpoint, dhwSetpointReduced, dhwMax } = fresh;
    if ([dhwSetpoint, dhwSetpointReduced, dhwMax].includes(undefined)) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (wanted.value > this.config.dhwCap) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
    if (spec.reduced) {
      // 1612 never above 1610, 1614, the ceiling nor 65 °C.
      const high = Math.min(SETPOINT_LIMITS.dhw.max, dhwMax, this.config.dhwCap, dhwSetpoint);
      const low = SETPOINT_LIMITS.dhw.min;
      if (low > high) {
        throw this.refusal(ERRORS.missingValue);
      }
      if (wanted.value < low || wanted.value > high) {
        throw this.refusal(ERRORS.outOfDeviceRange(low, high));
      }
      return;
    }
    // 1610 lies between the reduced setpoint (1612) and its max (1614), and
    // never above the ceiling.
    const low = Math.max(SETPOINT_LIMITS.dhw.min, dhwSetpointReduced);
    const high = Math.min(SETPOINT_LIMITS.dhw.max, dhwMax, this.config.dhwCap);
    if (dhwSetpointReduced > this.config.dhwCap) {
      // 1610 can never go below 1612: no setpoint fits under the ceiling.
      throw this.refusal(ERRORS.reducedAboveCap(dhwSetpointReduced, this.config.dhwCap));
    }
    if (low > high) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (wanted.value < low || wanted.value > high) {
      throw this.refusal(ERRORS.outOfDeviceRange(low, high));
    }
  }

  /** Reads after a command, spaced: its effect, then a check. */
  followUp() {
    const adapter = this.adapter;
    const generation = this.generation;
    // A write may have left: the next command waits a little, so that two
    // settings are never written back to back.
    this.quietUntil = this.now() + TIMINGS.commandSpacing;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        adapter.followUps.delete(handle);
        // Never sooner than the backoff: an adapter that stopped answering
        // is read again on its own schedule only.
        if (generation === this.generation && this.adapter?.online !== false) {
          this.tick().catch(() => this.logger.error('BSB-LAN refresh failed'));
        }
      }, delay);
      adapter.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until a read shows it: a new command is always sent,
   * never answered "already so" on a value that may not show the previous
   * one yet. The start value is kept: a read equal to it lifts nothing
   * until a move was seen.
   */
  guard(key, plan) {
    this.guards.set(key, { ...plan, moved: false, until: this.now() + TIMINGS.guard });
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read, through the guards and the kept stops of its adapter: never
   * lifted on an unknown value. `confirm`: the read back of a write (it
   * never writes a stop again nor counts as a second read).
   */
  observe(mac, values, { stamps = {}, confirm = false, periodic = false } = {}) {
    for (const role of COMMAND_ROLES) {
      const key = `${mac}:${role}`;
      if (!this.guardActive(key)) {
        continue;
      }
      const value = comparable(role, values);
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(key);
      }
    }
    this.observeStops(mac, values, { stamps, confirm, periodic });
  }

  // --- Kept stops (Protection, hot water Off) ------------------------------------

  /**
   * A protective command is kept in `memory.stops` (and /data) until a read
   * that LEFT after it shows it applied. Every decision rests on the
   * departure order of the requests (`ioSeq` stamps) and the arrival order
   * of the commands (`arrival`), never on when an answer comes back:
   *   - lifted by a command of the same role that arrived after it, left and
   *     was not refused (status 2, 4xx: kept); a stop read from /data is
   *     older than any command of this run;
   *   - "applied": a read of its own parameter that left after the click;
   *   - after a write of it left, the first read of its parameter that left
   *     after the write is the reference "not applied" (`after`); a later
   *     periodic read still showing it writes it again (3 times at most, one
   *     per periodic read); only another mode, read twice in a row on reads
   *     that left after the write, lifts it (changed at the boiler). A value
   *     from before is never taken for "changed elsewhere";
   *   - never sent: tried again every TIMINGS.stopRetry, never given up
   *     (held while credentials are refused, until new ones or the button);
   *   - it belongs to its adapter (MAC) and address: never written to
   *     another adapter; before the MAC is read, only to its own address.
   * /data is never awaited on this path: the next check is armed before
   * each save, and every save is bounded.
   */
  keepStop(mac, role, arrival) {
    const stops = this.memory.stops.filter((k) => !(k.mac === mac && k.role === role));
    stops.push({
      mac,
      role,
      address: this.adapter ? addressKey(this.adapter.address) : undefined,
      sent: 0,
      after: undefined,
      other: undefined,
      diff: 0,
      arrival,
      clickSeq: this.ioSeq,
      writeSeq: 0,
      seenSeq: this.ioSeq,
    });
    this.memory.stops = stops;
    this.armStopCheck();
    void this.saveMemory();
    this.showStops();
  }

  /** The status says where the kept stops stand (never awaited). */
  showStops() {
    this.updateStatus().catch(() => {});
  }

  stopOf(mac, role) {
    return this.memory.stops.find((k) => k.mac === mac && k.role === role);
  }

  /**
   * A stop may be written to the adapter configured now: its MAC is the
   * one read, or (MAC not read yet) the address is the stop's own.
   */
  canSendStop(stop) {
    const adapter = this.adapter;
    if (!adapter) {
      return false;
    }
    // The last MAC /JI gave at this address (even before its read ends).
    const known = adapter.lastMac ?? adapter.mac;
    if (known) {
      return known === stop.mac;
    }
    return stop.address !== undefined && stop.address === addressKey(adapter.address);
  }

  /** A write of the stop left (a status, or a silence after it left). */
  stopSent(mac, role, writeStamp) {
    const stop = this.stopOf(mac, role);
    if (stop) {
      stop.sent = Math.min(stop.sent + 1, 1000);
      stop.restart = false;
      stop.writeSeq = writeStamp;
      stop.seenSeq = Math.max(stop.seenSeq ?? 0, writeStamp);
      stop.diff = 0;
      stop.other = undefined;
      this.armStopCheck();
      void this.saveMemory();
      this.showStops();
    }
  }

  /** A command that arrived after the stop left and was not refused: the stop gives way. */
  liftStopsBefore(mac, role, arrival) {
    const stop = this.stopOf(mac, role);
    if (stop && (stop.arrival ?? 0) < arrival) {
      this.liftStop(mac, role, 'lifted by a newer command');
    }
  }

  liftStop(mac, role, why) {
    const stop = this.stopOf(mac, role);
    if (!stop) {
      return;
    }
    this.memory.stops = this.memory.stops.filter((k) => k !== stop);
    this.logger.info(`BSB-LAN ${role}: protective command ${why}`);
    void this.saveMemory();
    this.showStops();
  }

  observeStops(mac, values, { stamps = {}, confirm = false, periodic = false } = {}) {
    for (const stop of [...this.memory.stops]) {
      if (stop.mac !== mac) {
        continue;
      }
      const spec = COMMANDS[stop.role];
      const stamp = stamps[spec.id];
      const value = comparable(stop.role, values);
      // Only a read of its own parameter, that left after the click.
      if (stamp === undefined || value === undefined || stamp <= (stop.clickSeq ?? 0)) {
        continue;
      }
      if (value === spec.protective) {
        this.liftStop(mac, stop.role, 'applied');
        continue;
      }
      // Before its write left, a read says nothing of it (the retry sends it).
      if (stop.sent === 0 || stamp <= (stop.writeSeq ?? 0) || stamp <= (stop.seenSeq ?? 0)) {
        continue;
      }
      stop.seenSeq = stamp;
      if (stop.after === undefined) {
        // The first read after the write: what "not applied" looks like.
        stop.after = value;
      }
      if (value === stop.after) {
        stop.diff = 0;
        stop.other = undefined;
        if (periodic && !confirm && stop.sent <= TIMINGS.protectiveResends) {
          this.timers.setTimeout(() => this.sendStop(stop, 'written again'), 0);
        }
        void this.saveMemory();
        continue;
      }
      // Another mode than the one left after its write: changed at the boiler?
      stop.diff = stop.other === value ? stop.diff + 1 : 1;
      stop.other = value;
      if (stop.diff >= 2) {
        this.liftStop(mac, stop.role, 'lifted: another mode read twice');
      } else {
        void this.saveMemory();
      }
    }
  }

  /** The next check of the stops not sent yet, armed before any save. */
  armStopCheck(delay = TIMINGS.stopRetry) {
    if (
      !this.memory.stops.some(
        (k) => k.sent === 0 || (k.restart && k.sent <= TIMINGS.protectiveResends),
      )
    ) {
      return;
    }
    if (this.stopTimer !== undefined) {
      if (delay !== 0) {
        return;
      }
      this.timers.clearTimeout(this.stopTimer);
    }
    const generation = this.generation;
    this.stopTimer = this.timers.setTimeout(() => {
      this.stopTimer = undefined;
      if (generation === this.generation) {
        this.flushStops();
      }
    }, delay);
  }

  /**
   * Sends the kept stops: those never sent (at start: every one not past
   * its resends), only to their own adapter. Refused credentials hold them
   * until new ones are saved or the test button is pressed (`force`); a
   * pause does not.
   */
  flushStops({ atStart = false, force = false } = {}) {
    if (this.stopTimer !== undefined) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    const authHeld = this.memory.auth.until > this.now() && !force && !atStart;
    for (const stop of [...this.memory.stops]) {
      // Never sent; or kept from before a restart (sent once this run, at
      // start, or once its adapter's MAC is read when its address is not known).
      const due = stop.sent === 0 || (stop.restart && stop.sent <= TIMINGS.protectiveResends);
      if (due && !authHeld && this.canSendStop(stop)) {
        this.sendStop(stop, atStart ? 'sent after a restart' : 'sent again (not sent before)');
      }
    }
    // Re-armed for those still not sent (also while credentials are refused).
    this.armStopCheck();
  }

  sendStop(stop, why) {
    const key = `${stop.mac}:${stop.role}`;
    if (this.stopFlight.has(key) || !this.memory.stops.includes(stop) || !this.adapter) {
      return;
    }
    if (!this.canSendStop(stop)) {
      return;
    }
    const spec = COMMANDS[stop.role];
    const wanted = {
      id: spec.id,
      text: String(spec.codes[spec.protective]),
      value: spec.protective,
      key: spec.protective,
      protective: true,
    };
    this.logger.warn(`BSB-LAN ${stop.role}: ${spec.protective} ${why}`);
    this.protect({ mac: stop.mac, role: stop.role }, wanted, this.now(), { kept: true })
      .catch((err) => this.logger.warn(`BSB-LAN ${stop.role} kept stop: ${err.message}`))
      .finally(() => this.armStopCheck());
  }
}

const join2 = (a, b) => ({ en: `${a.en} ${b.en}`, fr: `${a.fr} ${b.fr}` });
