// -----------------------------------------------------------------------------
// Forum t/11458 n° 15 (XDECO, 0.4.0): after a complete reconfiguration, an
// extra parameter (1020, heating curve slope "1.46") typed once the device
// was created gives no feature: Gladys adds a feature to a created device
// only through "Update" in the Discovery tab, and the integration said
// nothing. A parameter without a usable value (1042?) said nothing either.
// Both are now named in the status, with what to do or why. SDK fake
// Gladys, fake BSB-LAN, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BsbLanApp } from '../src/app.js';
import { SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { extraIssue, extraOf } from '../src/params.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC_ID, NOW, fakeBsbLan, fullParams, settle } from './fixtures/fakeBsbLan.js';

const CONFIG = { address: HOST };
const device = `ext:test-integration:bsblan:${MAC_ID}`;

/** 1020 as BSB-LAN 5.x prints a heating curve slope (VALS, no unit). */
const slope = {
  name: 'Heating curve slope',
  dataType_name: 'GRADIENT_SMALL',
  dataType_family: 'VALS',
  error: 0,
  value: '1.46',
  desc: '',
  precision: 0.01,
  dataType: 0,
  readwrite: 0,
  unit: '',
};

async function setup(t, { params = fullParams(), config = CONFIG } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const bsb = fakeBsbLan({ params });
  const gladys = createFakeGladys({ config });
  const silent = () => {};
  const logger = { debug: silent, info: silent, warn: silent, error: silent };
  const app = new BsbLanApp({
    gladys,
    logger,
    request: bsb.request,
    store: memoryStore(),
    now: () => Date.now(),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(100);
      await settle();
    }
  };
  const connecting = gladys.connect();
  await advance(3 * SECOND);
  await connecting;
  await advance(2 * SECOND);
  const create = async () => {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await advance(SECOND);
  };
  const status = () => gladys.fake.connectionStatus.message.fr;
  const roles = (d) => d.features.map((f) => f.external_id.split(':').pop());
  return { gladys, app, bsb, advance, create, status, roles };
}

test('n° 15: 1020 typed after the device was created: the status says to click "Update" in Discovery', async (t) => {
  const params = { ...fullParams(), 1020: slope };
  const s = await setup(t, { params });
  await s.create();
  // XDECO types 1020 in the extra parameters once the device exists.
  await s.app.configUpdated({ ...CONFIG, extra_parameters: '1020' });
  await s.advance(40 * SECOND);
  const discovered = s.gladys.fake.discoveredDevices.find((d) => d.external_id === device);
  assert.ok(s.roles(discovered).includes('param-1020'), 'offered in Discovery');
  const created = s.gladys.fake.devices.find((d) => d.external_id === device);
  assert.ok(!s.roles(created).includes('param-1020'), 'not in the created device by itself');
  assert.match(
    s.status(),
    /Paramètres supplémentaires lus mais pas encore dans l'appareil créé : 1020\. Ouvrez l'onglet Découverte/,
  );
  // "Update" in Discovery: the feature is there, its value follows, the note goes.
  await s.create();
  await s.advance(40 * SECOND);
  assert.doesNotMatch(s.status(), /pas encore dans l'appareil/);
  assert.equal(s.gladys.fake.lastState(`${device}:param-1020`), 1.46);
});

test('n° 15: typed before the device is created, 1020 is in it at once, no note', async (t) => {
  const params = { ...fullParams(), 1020: slope };
  const s = await setup(t, { params, config: { ...CONFIG, extra_parameters: '1020' } });
  await s.create();
  await s.advance(40 * SECOND);
  const created = s.gladys.fake.devices.find((d) => d.external_id === device);
  assert.ok(s.roles(created).includes('param-1020'));
  assert.doesNotMatch(s.status(), /Paramètres supplémentaires/);
  assert.equal(s.gladys.fake.lastState(`${device}:param-1020`), 1.46);
});

test('n° 15: a parameter without a usable value is named in the status, with why', async (t) => {
  const params = {
    ...fullParams(),
    1042: { ...slope, name: 'Unknown', error: 7, value: '' },
    1043: { ...slope, value: '---' },
    1044: { ...slope, value: '1.2.3' },
  };
  const s = await setup(t, {
    params,
    config: { ...CONFIG, extra_parameters: '1042, 1043, 1044, 1045' },
  });
  await s.create();
  await s.advance(40 * SECOND);
  const text = s.status();
  assert.match(text, /Paramètres supplémentaires sans valeur de BSB-LAN, donc sans fonctionnalité/);
  assert.match(text, /1042 \(erreur de BSB-LAN : paramètre inconnu du régulateur \?\)/);
  // 1043: "---" with its type (VALS): an empty feature, said apart (n° 17).
  assert.doesNotMatch(text, /1043 \(inactif/);
  assert.match(
    text,
    /que BSB-LAN donne à « --- » pour l'instant : 1043 \(vide, aucune valeur encore\)\./,
  );
  assert.match(text, /1044 \(valeur illisible en nombre ou en texte\)/);
  // The fake answers an unknown id as BSB-LAN does: inactive.
  assert.match(text, /1045 \(inactif/);
  assert.match(s.gladys.fake.connectionStatus.message.en, /1042 \(BSB-LAN error/);
});

test('n° 15: extraIssue says why, and nothing for a usable value', () => {
  assert.equal(extraOf(slope).value, 1.46);
  assert.equal(extraIssue(slope), undefined);
  assert.equal(extraIssue(undefined), 'absent');
  assert.equal(extraIssue({ ...slope, error: 7 }), 'error');
  assert.equal(extraIssue({ ...slope, value: '---' }), 'pending', 'typed VALS: an empty feature');
  assert.equal(extraIssue({ ...slope, value: null }), 'pending');
  assert.equal(extraIssue({ ...slope, dataType_family: undefined, value: '---' }), 'inactive');
  assert.equal(extraIssue({ ...slope, unit: '°F', value: '70' }), 'fahrenheit');
  assert.equal(extraIssue({ ...slope, value: 'x'.repeat(50) }), 'unreadable');
});
