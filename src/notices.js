// -----------------------------------------------------------------------------
// The outcome of a command in the log. A command that waits behind another one,
// or that a newer value of the same setting replaced while it waited, is normal
// operation: logged as info, each with its own line (XDECO, t/11458 n° 9).
// So is a command still going on when Gladys gets its answer (a slow
// adapter, 0.3.4). Every other refusal or failure stays a warning.
// -----------------------------------------------------------------------------

export const NOTICES = Object.freeze({
  queued: 'queued',
  replaced: 'replaced',
  goingOn: 'goingOn',
});

const LINES = {
  [NOTICES.queued]: 'waiting: another command to BSB-LAN is running, sent after it',
  [NOTICES.replaced]: 'not sent: replaced by a newer value of the same setting',
  [NOTICES.goingOn]: 'BSB-LAN answers slowly: the command goes on, its outcome follows in the log',
};

/** The log line of a notice. */
export const noticeLine = (notice) => LINES[notice];

/**
 * Logs the end of a command that did not succeed: `what` names it (never a
 * secret), `warned` heads the warning of any other outcome. The "waiting"
 * answer was logged as info when the command started waiting: debug here.
 */
export function logOutcome(logger, what, err, warned = `${what} refused`) {
  if (err?.notice === NOTICES.queued) {
    logger?.debug(`${what} answered: ${LINES[NOTICES.queued]}`);
    return;
  }
  if (err?.notice === NOTICES.goingOn) {
    logger?.info(`${what} ${LINES[NOTICES.goingOn]}`);
    return;
  }
  if (err?.notice === NOTICES.replaced) {
    logger?.info(`${what} ${LINES[NOTICES.replaced]}`);
    return;
  }
  logger?.warn(`${warned}: ${err?.message}`);
}
