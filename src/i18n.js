// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors. None
// of them ever carries the passkey, the user name or the password.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const join = (parts) =>
  both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));

export const DEVICE_NAME = both('Heating (BSB-LAN)', 'Chauffage (BSB-LAN)');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Heating mode', 'Mode de chauffage'),
  [FEATURES.MODE_STATE]: both('Heating mode (read)', 'Mode de chauffage (lu)'),
  [FEATURES.HEATING_STATUS]: both('Heating circuit status', 'État du circuit de chauffage'),
  [FEATURES.HEATING_SETPOINT]: both('Comfort setpoint', 'Consigne confort'),
  [FEATURES.HEATING_SETPOINT_REDUCED]: both('Reduced setpoint', 'Consigne réduite'),
  [FEATURES.TEMP_ROOM]: both('Room temperature', 'Température de la pièce'),
  [FEATURES.TEMP_OUTDOOR]: both('Outside temperature', 'Température extérieure'),
  [FEATURES.DHW_MODE]: both('Hot water mode', "Mode de l'eau chaude"),
  [FEATURES.DHW_SETPOINT]: both('Hot water setpoint', "Consigne d'eau chaude"),
  [FEATURES.DHW_SETPOINT_REDUCED]: both(
    'Hot water reduced setpoint',
    "Consigne réduite de l'eau chaude",
  ),
  [FEATURES.TEMP_DHW]: both('Hot water temperature', "Température de l'eau chaude"),
  [FEATURES.DHW_PUMP]: both('Hot water pump running', "Pompe d'eau chaude en marche"),
  [FEATURES.ENERGY_TOTAL]: both('Energy brought in (kWh)', 'Énergie apportée (kWh)'),
};

/** The heating modes (src/params.js MODES and PPS_MODES). */
export const MODE_NAMES = {
  automatic: both('Automatic (time program)', 'Automatique (programme horaire)'),
  comfort: both('Comfort', 'Confort'),
  reduced: both('Reduced', 'Réduit'),
  protection: both('Protection (frost protection)', 'Protection (hors-gel)'),
  manual: both('Manual', 'Manuel'),
  off: both('Off', 'Arrêt'),
};

/** The hot water modes (src/params.js DHW_MODES). */
export const DHW_MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  on: both('On', 'Marche'),
  eco: both('Eco', 'Éco'),
};

export const STATE_TEXTS = {
  unknownMode: (code) => both(`Unknown mode (${code})`, `Mode inconnu (${code})`),
  statusCode: (code) => both(`Status ${code}`, `État ${code}`),
  offline: both('BSB-LAN unreachable', 'BSB-LAN injoignable'),
  otherAdapter: both(
    'Another adapter answers at this address',
    'Un autre adaptateur répond à cette adresse',
  ),
};

const PROBLEMS = {
  empty: both(
    'Enter the IP address of your BSB-LAN adapter, then save.',
    "Saisissez l'adresse IP de votre adaptateur BSB-LAN, puis enregistrez.",
  ),
  https: both(
    'BSB-LAN speaks plain http only: enter the address without https://.',
    "BSB-LAN ne parle qu'en http simple : saisissez l'adresse sans https://.",
  ),
  credentials: both(
    'Put the user name and the password in their own fields, not in the address.',
    "Mettez l'identifiant et le mot de passe dans leurs champs, pas dans l'adresse.",
  ),
  path: both(
    'The address must not carry a path: put the passkey in its own field.',
    "L'adresse ne doit pas contenir de chemin : mettez la clé de passe dans son champ.",
  ),
  invalid: both(
    'Invalid address (an IPv4 address or a host name, with an optional port).',
    "Adresse invalide (une adresse IPv4 ou un nom d'hôte, avec un port en option).",
  ),
  passkey: both(
    'Invalid passkey: letters, digits, "-" and "_" only, as in the BSB-LAN configuration.',
    'Clé de passe invalide : lettres, chiffres, « - » et « _ » seulement, comme dans la configuration de BSB-LAN.',
  ),
  passwordWithoutUser: both(
    'A password without a user name: fill both, or neither.',
    'Un mot de passe sans identifiant : remplissez les deux, ou aucun.',
  ),
  userWithoutPassword: both(
    'A user name without a password: fill both, or neither.',
    'Un identifiant sans mot de passe : remplissez les deux, ou aucun.',
  ),
  credentialsInvalid: both(
    'The user name or the password holds a character HTTP cannot carry (an accent, an invisible character, or ":" in the user name).',
    "L'identifiant ou le mot de passe contient un caractère que HTTP ne peut pas transporter (un accent, un caractère invisible, ou « : » dans l'identifiant).",
  ),
};

/** The integration status, the button and the logs a user may read. */
export const T = {
  /** A configuration that cannot be used; `typed`: the invalid address, already cleaned. */
  problem: (key, typed) => {
    const text = Object.hasOwn(PROBLEMS, key) ? PROBLEMS[key] : PROBLEMS.invalid;
    return typed ? join([text, both(`(${typed})`, `(${typed})`)]) : text;
  },
  connecting: both('Reading BSB-LAN…', 'Lecture de BSB-LAN…'),
  connected: ({ model, bus, version }, notes = []) =>
    join([
      both(
        `Connected: ${model ?? 'controller'} on the ${bus} bus (BSB-LAN ${version ?? '?'}).`,
        `Connecté : ${model ?? 'régulateur'} sur le bus ${bus} (BSB-LAN ${version ?? '?'}).`,
      ),
      ...notes,
    ]),
  unreachable: (address, reason, wait) =>
    both(
      `Could not read BSB-LAN at ${address} (${reason}; next try in ${wait.en}). Check the address and that the adapter is on.`,
      `Lecture de BSB-LAN ${address} impossible (${reason} ; nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que l'adaptateur est allumé.`,
    ),
  notFound: (address, wait) =>
    both(
      `BSB-LAN at ${address} answers "not found" (HTTP 404): check the passkey (next try in ${wait.en}).`,
      `BSB-LAN ${address} répond « introuvable » (HTTP 404) : vérifiez la clé de passe (nouvel essai dans ${wait.fr}).`,
    ),
  authRefused: (wait) =>
    both(
      `BSB-LAN refused the user name or the password: check them and save. Next try in ${wait.en}; "Test the connection" tries now.`,
      `BSB-LAN a refusé l'identifiant ou le mot de passe : vérifiez-les et enregistrez. Nouvel essai dans ${wait.fr} ; « Tester la connexion » essaie tout de suite.`,
    ),
  authNeeded: (wait) =>
    both(
      `BSB-LAN asks for a user name and a password: fill them and save. Next try in ${wait.en}.`,
      `BSB-LAN demande un identifiant et un mot de passe : remplissez-les et enregistrez. Nouvel essai dans ${wait.fr}.`,
    ),
  busy: (wait) =>
    both(
      `BSB-LAN is busy or failing (HTTP 429 or 5xx): paused, next try in ${wait.en}.`,
      `BSB-LAN est occupé ou en erreur (HTTP 429 ou 5xx) : en pause, nouvel essai dans ${wait.fr}.`,
    ),
  unsupportedVersion: (wait) =>
    both(
      `This BSB-LAN firmware does not give its JSON-API version (/JV, version 1.0 at least, as python-bsblan requires): update BSB-LAN (next try in ${wait.en}).`,
      `Ce micrologiciel BSB-LAN ne donne pas sa version d'API JSON (/JV, version 1.0 au moins, comme l'exige python-bsblan) : mettez BSB-LAN à jour (nouvel essai dans ${wait.fr}).`,
    ),
  noMac: (wait) =>
    both(
      `BSB-LAN did not give its MAC address (/JI), which identifies the device in Gladys (next try in ${wait.en}).`,
      `BSB-LAN n'a pas donné son adresse MAC (/JI), qui identifie l'appareil dans Gladys (nouvel essai dans ${wait.fr}).`,
    ),
  notes: {
    fahrenheit: both(
      'The controller gives °F: its temperatures are not shown (the features are in °C).',
      'Le régulateur donne des °F : ses températures ne sont pas affichées (les fonctionnalités sont en °C).',
    ),
    readOnlyBus: both(
      'BSB-LAN is set to read only ("Bus write access" off): commands are refused.',
      'BSB-LAN est réglé en lecture seule (écriture sur le bus désactivée) : les commandes sont refusées.',
    ),
    pps: both('PPS bus: read only in this version.', 'Bus PPS : lecture seule dans cette version.'),
    otherAdapter: both(
      'The created device belongs to another adapter (another MAC address): add the new device from the Discovery tab.',
      "L'appareil créé appartient à un autre adaptateur (autre adresse MAC) : ajoutez le nouvel appareil depuis l'onglet Découverte.",
    ),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  badMode: both('Unknown heating mode: not sent.', 'Mode de chauffage inconnu : non envoyé.'),
  badNumber: both(
    'The setpoint must be a number: not sent.',
    'La consigne doit être un nombre : non envoyée.',
  ),
  badStep: (step) =>
    both(
      `The setpoint must be a multiple of ${step} °C: not sent.`,
      `La consigne doit être un multiple de ${String(step).replace('.', ',')} °C : non envoyée.`,
    ),
  outOfRange: (min, max) =>
    both(
      `The setpoint must be between ${min} and ${max} °C: not sent.`,
      `La consigne doit être comprise entre ${min} et ${max} °C : non envoyée.`,
    ),
  outOfDeviceRange: (min, max) =>
    both(
      `The controller accepts this setpoint between ${min} and ${max} °C now: not sent.`,
      `Le régulateur accepte cette consigne entre ${min} et ${max} °C actuellement : non envoyée.`,
    ),
  dhwCap: (cap) =>
    both(
      `Hot water is capped at ${cap} °C (scalding risk, see "Hot water ceiling" in the configuration): not sent.`,
      `L'eau chaude est plafonnée à ${cap} °C (risque de brûlure, voir « Plafond de l'eau chaude » dans la configuration) : non envoyée.`,
    ),
  unknownDevice: both(
    'This device is not the adapter read now (BSB-LAN not answering, or another adapter): not sent.',
    "Cet appareil n'est pas l'adaptateur lu actuellement (BSB-LAN sans réponse, ou autre adaptateur) : non envoyée.",
  ),
  pps: both(
    'PPS bus: commands are not supported in this version: not sent.',
    'Bus PPS : les commandes ne sont pas prises en charge dans cette version : non envoyée.',
  ),
  readOnlyBus: both(
    'BSB-LAN is set to read only (bus write access off in its configuration): not sent.',
    'BSB-LAN est réglé en lecture seule (écriture sur le bus désactivée dans sa configuration) : non envoyée.',
  ),
  paused: both(
    'BSB-LAN is paused (refused credentials, or busy): not sent.',
    'BSB-LAN est en pause (identifiants refusés, ou occupé) : non envoyée.',
  ),
  stillRunning: both(
    'Another command to BSB-LAN is still running: not sent.',
    'Une autre commande vers BSB-LAN est encore en cours : non envoyée.',
  ),
  tooSlow: both(
    'BSB-LAN answered too slowly to send the command in time: not sent.',
    'BSB-LAN a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current value could not be read just before (${reason}): command not sent.`,
      `La valeur actuelle n'a pas pu être relue juste avant (${reason}) : commande non envoyée.`,
    ),
  missingValue: both(
    'BSB-LAN did not give the current value or the allowed range of this setting: not sent.',
    "BSB-LAN n'a pas donné la valeur actuelle ou la plage permise de ce réglage : non envoyée.",
  ),
  protectedMode: (mode) =>
    both(
      `The heating is in "${mode.en}" mode, which Gladys does not know: Gladys does not leave it. Not sent.`,
      `Le chauffage est en mode « ${mode.fr} », que Gladys ne connaît pas : Gladys n'en sort pas. Non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `BSB-LAN could not be reached (${reason}): command not sent.`,
      `BSB-LAN n'a pas pu être joint (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(`BSB-LAN refused the command (${reason}).`, `BSB-LAN a refusé la commande (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the value in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la valeur dans quelques secondes.`,
    ),
};
