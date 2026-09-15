import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1790000000000_init_webhooks';

/**
 * The hand-written array is what runs — a file in `umzug/` that is not listed here does nothing.
 */
export const umzugExports: Migration[] = [
  {
    name: 'init_webhooks',
    timestamp: 1790000000000,
    up: upInit,
    down: downInit,
  },
];
