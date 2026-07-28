import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1786000000000_init_gitlab_integration';

export const umzugExports: Migration[] = [
  {
    name: 'init_gitlab_integration',
    timestamp: 1786000000000,
    up: upInit,
    down: downInit,
  },
];
