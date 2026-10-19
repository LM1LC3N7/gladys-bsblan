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
import { DHW_CAP, FEATURES as F, LIMITS, SECOND, SETPOINT_LIMITS, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
} from './devices.js';
import { ERRORS, STATE_TEXTS, T, age, word } from './i18n.js';
import {
  MODE_CODES,
  P,
  POLL,
  SELECTABLE,
  adapterOf,
  apiVersionOf,
  decode,
  identificationOf,
  writeOutcome,
} from './params.js';
import { BsbClient } from './bsblan/client.js';
import { CODES, isAuthRefused, isBusy, reasonOf } from './bsblan/errors.js';
import { StatePublisher } from './publisher.js';
import { memoryStore, normalizeMemory, serializeMemory } from './store.js';

/** What the fresh read of a command asks, by role. */
const COMMAND_PARAMS = {
  [F.MODE]: [P.MODE],
  [F.HEATING_SETPOINT]: [P.COMFORT, P.PROTECTIVE, P.COMFORT_MAX],
  [F.DHW_SETPOINT]: [P.DHW_NOMINAL, P.DHW_REDUCED, P.DHW_NOMINAL_MAX],
};

/** The decoded values the fresh read of a command refreshes, by role. */
const COMMAND_VALUES = {
  [F.MODE]: ['mode'],
  [F.HEATING_SETPOINT]: ['heatingSetpoint', 'heatingMin', 'heatingMax'],
  [F.DHW_SETPOINT]: ['dhwSetpoint', 'dhwSetpointReduced', 'dhwMax'],
};

const tenth = (value) => (value === undefined ? undefined : Math.round(value * 10));

/** What a command compares, for a role: the mode key or the setpoint in tenths of °C. */
function comparable(role, values) {
  if (role === F.MODE) {
    return values?.mode?.key;
  }
  return tenth(role === F.HEATING_SETPOINT ? values?.heatingSetpoint : values?.dhwSetpoint);
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
      timer: undefined,
      running: undefined,
      followUps: new Set(),
    };
  }

  async loadMemory() {
    if (this.memoryLoaded) {
      return;
    }
    this.memoryLoaded = true;
    const raw = await this.store.load().catch(() => null);
    this.memory = normalizeMemory(raw, this.now());
  }

  saveMemory() {
    return this.store.save(serializeMemory(this.memory)).catch((err) => {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`The state could not be saved in /data: ${err?.code ?? 'error'}`);
      }
    });
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
    await this.setStatus(false, T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
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
        this.tick().catch(() => this.logger.error('BSB-LAN refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the user asked. */
  tick({ force = false } = {}) {
    const adapter = this.adapter;
    if (!adapter) {
      return Promise.resolve();
    }
    if (!adapter.running) {
      adapter.running = this.run(adapter, { force }).finally(() => {
        adapter.running = undefined;
      });
    }
    return adapter.running;
  }

  async run(adapter, { force }) {
    const generation = this.generation;
    const now = this.now();
    if (this.memory.pausedUntil > now) {
      this.halted(adapter, 'busy', this.memory.pausedUntil - now);
    } else if (this.memory.auth.until > now && !force) {
      this.halted(adapter, 'auth', this.memory.auth.until - now);
    } else {
      try {
        await this.read(adapter, generation);
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
    adapter.error = error;
    adapter.status = undefined;
    adapter.wait = wait;
  }

  async read(adapter, generation) {
    const { client } = adapter;
    const info = adapterOf(await client.info());
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
    if (info.bus === 'bsb' && !adapter.model) {
      ids.push(P.IDENTIFICATION);
    }
    // A few parameters per request: the Gate frees between them, so a
    // command never waits for a whole poll.
    const merged = {};
    for (const batch of chunks(ids, LIMITS.parametersPerRead)) {
      const answer = await client.query(batch);
      if (generation !== this.generation) {
        return;
      }
      for (const id of batch) {
        if (Object.hasOwn(answer, id)) {
          merged[id] = answer[id];
        }
      }
    }
    const values = decode(info.bus, merged);
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
    this.observe(info.mac, values);
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
    await this.setStatus(connected, message);
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
    } else if (!adapter.info.writable) {
      notes.push(T.notes.readOnlyBus);
    }
    const created = this.ourDevices();
    if (created.length > 0 && !created.some((entry) => entry.mac === adapter.mac)) {
      notes.push(T.notes.otherAdapter);
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
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, checked strictly (null, '' or 'abc' are not a
   * number; a mode is one of the exact keys of the list), within the hard
   * limits. Returns `{ id, text, value, key? }`.
   */
  parseCommand(role, value) {
    if (role === F.MODE) {
      if (typeof value !== 'string' || !SELECTABLE.includes(value)) {
        throw this.refusal(ERRORS.badMode);
      }
      return { id: P.MODE, text: String(MODE_CODES[value]), value, key: value };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (role === F.HEATING_SETPOINT) {
      const { min, max } = SETPOINT_LIMITS.heating;
      if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
        throw this.refusal(ERRORS.badStep(0.1));
      }
      if (number < min || number > max) {
        throw this.refusal(ERRORS.outOfRange(min, max));
      }
      const rounded = Math.round(number * 10) / 10;
      return { id: P.COMFORT, text: rounded.toFixed(1), value: rounded };
    }
    // The hot water setpoint: whole degrees, never above the hard ceiling
    // nor the configured one.
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
    return { id: P.DHW_NOMINAL, text: String(number), value: number };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight || received < this.quietUntil) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, wanted, received);
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
  checkBeforeSend(generation, { mac, role }, wanted) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.blockedUntil() > 0) {
      throw this.refusal(ERRORS.paused);
    }
    if (generation !== this.generation || !this.live || mac !== this.adapter.mac) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.adapter.info.bus === 'pps') {
      throw this.refusal(ERRORS.pps);
    }
    if (!this.adapter.info.writable) {
      throw this.refusal(ERRORS.readOnlyBus);
    }
    // The ceiling may have been lowered since the command arrived.
    if (
      role === F.DHW_SETPOINT &&
      (wanted.value > this.config.dhwCap || wanted.value > DHW_CAP.max)
    ) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  async command(target, wanted, received) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, target, wanted);
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

  /** The command inside its session (the Gate is held: `raw` requests). */
  async commandSession(raw, target, wanted, { generation, adapter, received, sendBy, readBy }) {
    const { mac, role } = target;
    // The parameters just before acting, never the values in memory.
    const ids = COMMAND_PARAMS[role];
    let answer;
    try {
      answer = await raw.query(ids, { answerBy: readBy });
    } catch (err) {
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
    const fresh = decode('bsb', picked);
    for (const key of COMMAND_VALUES[role]) {
      adapter.values[key] = fresh[key];
    }
    this.observe(mac, adapter.values);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));

    this.checkRange(role, wanted, fresh);
    const current = comparable(role, fresh);
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const expected = role === F.MODE ? wanted.key : tenth(wanted.value);
    const key = `${mac}:${role}`;
    if (current === expected && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, target, wanted);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`BSB-LAN ${role}: ${wanted.value}`);
    const plan = { from: current, expected };
    let written;
    try {
      written = await raw.set(wanted.id, wanted.text, {
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        // The very last check, right before the request leaves.
        beforeSend: () => this.checkBeforeSend(generation, target, wanted),
      });
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
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    const outcome = writeOutcome(written, wanted.id);
    if (outcome === 'refused') {
      this.followUp();
      throw this.refusal(ERRORS.refused('BSB-LAN status 2'));
    }
    this.guard(key, plan);
    this.followUp();
    if (outcome !== 'ok') {
      throw this.refusal(ERRORS.sentUnconfirmed('no status 1'));
    }
  }

  /** The range of the controller, read just now (never the values in memory). */
  checkRange(role, wanted, fresh) {
    if (role === F.MODE) {
      if (fresh.mode === undefined) {
        throw this.refusal(ERRORS.missingValue);
      }
      if (!fresh.mode.key) {
        throw this.refusal(ERRORS.protectedMode(STATE_TEXTS.unknownMode(fresh.mode.code)));
      }
      return;
    }
    if (role === F.HEATING_SETPOINT) {
      const { heatingSetpoint, heatingMin, heatingMax } = fresh;
      if ([heatingSetpoint, heatingMin, heatingMax].includes(undefined)) {
        throw this.refusal(ERRORS.missingValue);
      }
      const low = Math.max(SETPOINT_LIMITS.heating.min, heatingMin);
      const high = Math.min(SETPOINT_LIMITS.heating.max, heatingMax);
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
    // 1610 lies between the reduced setpoint (1612) and its max (1614).
    const low = Math.max(SETPOINT_LIMITS.dhw.min, dhwSetpointReduced);
    const high = Math.min(SETPOINT_LIMITS.dhw.max, dhwMax);
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
        if (generation === this.generation) {
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

  /** A read, through the guards of its adapter: never lifted on an unknown value. */
  observe(mac, values) {
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
  }
}

const join2 = (a, b) => ({ en: `${a.en} ${b.en}`, fr: `${a.fr} ${b.fr}` });
