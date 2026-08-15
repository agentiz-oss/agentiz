import { down as downMobileDevices, up as upMobileDevices } from './umzug/1787100000000_mobile_devices';

/**
 * This layer's own schema. It owns exactly one table — the push tokens of installed apps — which is
 * why it does not live in app-agentiz: a device is a property of this API's clients, not of the
 * pipeline domain. The push credentials are *not* here: those are app-manager settings, stored in
 * the platform's own `settings` table (see lib/push/settings.ts).
 */
export const migrations = {
  umzug: [
    {
      name: 'mobile_devices',
      timestamp: 1787100000000,
      up: upMobileDevices,
      down: downMobileDevices,
    },
  ],
};
