// -----------------------------------------------------------------------------
// The dashboard widget (SDK "Dashboard widgets"): read only, no button. Per
// heating circuit its room temperature, comfort and reduced setpoints, mode
// and status; the hot water when the controller has it. Built from the
// values of the last read, and only while that read is current (an adapter
// that stopped answering shows a line saying so, a pause or refused
// credentials their status, never old values as current). Pure: src/app.js
// gives the values and nudges the dashboards (spaced as Gladys requires).
// -----------------------------------------------------------------------------

import { DHW_MODE_NAMES, MODE_NAMES, STATE_TEXTS, num, word } from './i18n.js';
import { modeText } from './devices.js';

export const WIDGET_KEY = 'heating';

/**
 * The core keeps a content for `ttl_seconds` (10–3600): the read interval,
 * at most 60 s, so that a nudge lost on the way (Gladys away) costs a minute
 * at most.
 */
const TTL = { min: 10, max: 60 };
/** `text` body: 300 characters at most. */
const BODY_TEXT = 300;
/** `status` item: label and value up to 40 characters; `value` tile label up to 24. */
const ITEM_TEXT = 40;

const both = (en, fr) => ({ en, fr });

const TEXTS = {
  waiting: both('BSB-LAN not read yet.', 'BSB-LAN pas encore lu.'),
  offline: both(
    'BSB-LAN does not answer: no current value.',
    'BSB-LAN ne répond pas : aucune valeur actuelle.',
  ),
  room: both('Room', 'Ambiance'),
  roomOf: (circuit) => both(`Room, circuit ${circuit}`, `Ambiance circuit ${circuit}`),
  outdoor: both('Outside', 'Extérieur'),
  dhw: both('Hot water', 'Eau chaude'),
  circuit: (circuit) => both(`Circuit ${circuit}`, `Circuit ${circuit}`),
  mode: both('mode', 'mode'),
  setpoints: both('comfort / reduced', 'confort / réduite'),
  dhwSetpoints: both('setpoint / reduced', 'consigne / réduite'),
  status: both('status', 'état'),
  roomSetpoint: both('room setpoint', 'consigne de la pièce'),
};

const cut = (text) => (text.length > ITEM_TEXT ? `${text.slice(0, ITEM_TEXT - 1)}…` : text);

/** "20,5 °C", or "—" when the controller did not give it. */
const degrees = (value, language) =>
  Number.isFinite(value) ? `${word(num(Math.round(value * 10) / 10), language)} °C` : '—';

/** A status of the controller: its text, else "Status 114". */
const statusText = (read, language) =>
  read.desc ?? word(STATE_TEXTS.statusCode(read.code), language);

/**
 * The content of the widget. `values`: the decoded values of the last read
 * (src/params.js decode); `live`: whether they are current; `everRead`:
 * whether the adapter answered once; `pollSeconds`: the read interval.
 */
export function widgetContent({ values, live, everRead, reason, language, pollSeconds }) {
  const ttl = Math.min(TTL.max, Math.max(TTL.min, Math.round(pollSeconds) || 60));
  if (!live || !values) {
    // `reason`: the status of a pause or of refused credentials (BSB-LAN answered).
    const text = reason ?? word(everRead ? TEXTS.offline : TEXTS.waiting, language);
    return {
      ttl_seconds: ttl,
      components: [{ type: 'text', variant: 'body', text: text.slice(0, BODY_TEXT) }],
    };
  }
  const two = values.mode2 !== undefined;
  const tiles = [];
  const tile = (label, value, icon) => {
    if (Number.isFinite(value)) {
      tiles.push({
        type: 'value',
        label: word(label, language),
        value: Math.round(value * 10) / 10,
        unit: '°C',
        icon,
      });
    }
  };
  tile(two ? TEXTS.roomOf(1) : TEXTS.room, values.room, 'thermometer');
  if (two) {
    tile(TEXTS.roomOf(2), values.room2, 'thermometer');
  }
  tile(TEXTS.dhw, values.dhw, 'droplet');
  tile(TEXTS.outdoor, values.outdoor, 'sun');

  const items = [];
  const item = (head, what, value, color = 'neutral') =>
    items.push({
      label: cut(`${word(head, language)} · ${word(what, language)}`),
      value: cut(value),
      color,
    });
  const circuit = (n, mode, comfort, reduced, status) => {
    const head = TEXTS.circuit(n);
    if (mode !== undefined) {
      item(head, TEXTS.mode, modeText(mode, MODE_NAMES, language), 'primary');
    }
    if (comfort !== undefined || reduced !== undefined) {
      item(head, TEXTS.setpoints, `${degrees(comfort, language)} / ${degrees(reduced, language)}`);
    }
    if (status !== undefined) {
      item(head, TEXTS.status, statusText(status, language));
    }
  };
  circuit(1, values.mode, values.heatingSetpoint, values.heatingSetpointReduced, values.status);
  if (values.ppsSetpoint !== undefined) {
    item(TEXTS.circuit(1), TEXTS.roomSetpoint, degrees(values.ppsSetpoint, language));
  }
  if (two) {
    circuit(
      2,
      values.mode2,
      values.heating2Setpoint,
      values.heating2SetpointReduced,
      values.status2,
    );
  }
  if (values.dhwMode !== undefined) {
    item(TEXTS.dhw, TEXTS.mode, modeText(values.dhwMode, DHW_MODE_NAMES, language), 'primary');
  }
  if (values.dhwSetpoint !== undefined || values.dhwSetpointReduced !== undefined) {
    item(
      TEXTS.dhw,
      TEXTS.dhwSetpoints,
      `${degrees(values.dhwSetpoint, language)} / ${degrees(values.dhwSetpointReduced, language)}`,
    );
  }
  if (values.dhwStatus !== undefined) {
    item(TEXTS.dhw, TEXTS.status, statusText(values.dhwStatus, language));
  }

  const components = tiles.slice(0, 6);
  if (items.length > 0) {
    components.push({ type: 'status', items: items.slice(0, 10) });
  }
  return { ttl_seconds: ttl, components };
}
