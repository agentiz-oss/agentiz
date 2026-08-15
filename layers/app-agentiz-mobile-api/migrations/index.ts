import { down as downMobileDevices, up as upMobileDevices } from './umzug/1787100000000_mobile_devices';
import { down as downPushSettings, up as upPushSettings } from './umzug/1787200000000_mobile_push_settings';

/**
 * This layer's own schema: the push tokens of installed apps, and the push credentials themselves.
 * Neither lives in app-agentiz — a device is a property of this API's clients, not of the pipeline
 * domain, and the credentials belong wherever the delivery does.
 */
export const migrations = {
  umzug: [
    {
      name: 'mobile_devices',
      timestamp: 1787100000000,
      up: upMobileDevices,
      down: downMobileDevices,
    },
    {
      name: 'mobile_push_settings',
      timestamp: 1787200000000,
      up: upPushSettings,
      down: downPushSettings,
    },
  ],
};
