import { down as downMobileDevices, up as upMobileDevices } from './umzug/1787100000000_mobile_devices';
import { down as downDropTransport, up as upDropTransport } from './umzug/1787200000000_drop_device_transport';
import { down as downInboxDismissals, up as upInboxDismissals } from './umzug/1787300000000_inbox_dismissals';

/**
 * This layer's own schema. Both of its tables are properties of *this API's clients* rather than of
 * the pipeline domain, which is why they do not live in app-agentiz: the push tokens of installed
 * apps, and the inbox rows a person has read and decided not to act on (the inbox itself being this
 * layer's projection). The push credentials are *not* here: those are app-manager settings, stored
 * in the platform's own `settings` table (see lib/push/settings.ts).
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
      name: 'drop_device_transport',
      timestamp: 1787200000000,
      up: upDropTransport,
      down: downDropTransport,
    },
    {
      name: 'inbox_dismissals',
      timestamp: 1787300000000,
      up: upInboxDismissals,
      down: downInboxDismissals,
    },
  ],
};
