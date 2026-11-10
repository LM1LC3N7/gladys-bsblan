// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute: push() keeps
// the current value of a feature (the last one wins); unchanged values are
// skipped by publishChangedStates and sent again every 30 min. Whatever is
// left over (budget spent, Gladys unreachable) waits for the next flush, every
// second; a failure is logged once per cause (3 at most), then once when sending
// works again.
// Never energy consumption: this integration publishes no index.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

/** Distinct causes of a failure to send to Gladys logged during one outage. */
const MAX_CAUSES = 3;

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
    /** Sending to Gladys failed and has not worked since. */
    this.failing = false;
    /** The causes logged during this outage (digits ignored), MAX_CAUSES at most. */
    this.causes = new Set();
    /** "Further causes not logged" written during this outage. */
    this.capped = false;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      // Logged by send(): once per outage (XDECO n° 9), not every second.
      this.flush().catch(() => {});
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.send().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  /**
   * A failure is logged once per cause during one outage (a cause that only
   * differs by its digits, a time or a port, is the same), MAX_CAUSES at most,
   * then one line saying the others are not logged (review bsblan-033-r2 J1).
   */
  noteFailure(err) {
    this.failing = true;
    const message = String(err?.message ?? '').trim() || '(no message)';
    const cause = message.replace(/\d+/g, '#');
    if (this.causes.has(cause)) {
      return;
    }
    if (this.causes.size < MAX_CAUSES) {
      this.causes.add(cause);
      this.logger?.warn(
        `Sending to Gladys failed: ${message} (retried every second; a new cause is logged once more, ${MAX_CAUSES} at most)`,
      );
      return;
    }
    if (!this.capped) {
      this.capped = true;
      this.logger?.warn(
        'Sending to Gladys still fails: further causes not logged until it works again',
      );
    }
  }

  async send() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < MINUTE);
    const room = Math.min(LIMITS.statesPerMinute - this.window.length, LIMITS.statesPerRequest);
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
      if (this.failing) {
        this.failing = false;
        this.causes.clear();
        this.capped = false;
        this.logger?.info('Sending to Gladys works again');
      }
    } catch (err) {
      this.noteFailure(err);
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
