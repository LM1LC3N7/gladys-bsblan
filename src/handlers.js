// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';
import { logOutcome, shownValue } from './notices.js';
import { WIDGET_KEY } from './widget.js';

export function registerHandlers(gladys, app, logger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // The commands. A failure is logged here: the SDK only acks it to Gladys.
  gladys.onSetValue(async (device, feature, value) => {
    try {
      await app.setValue(device, feature, value);
    } catch (err) {
      // Waiting behind another command, or replaced by a newer value: info.
      // The value asked is in the line (XDECO, t/11458 n° 13).
      logOutcome(logger, `Command ${feature?.external_id} ${shownValue(value)}`, err);
      throw err;
    }
  });

  // The dashboard widget, read only (no button in this version).
  gladys.onWidgetGet(WIDGET_KEY, ({ language } = {}) => app.widget(language));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys).
  // getConfig() may fail: tried again, spaced, until it is read.
  gladys.on('connected', async () => {
    try {
      await app.connectedWith(() => gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
