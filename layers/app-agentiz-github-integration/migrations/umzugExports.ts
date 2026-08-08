import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1789000000000_init_github_integration';

export const umzugExports: Migration[] = [
  {
    name: 'init_github_integration',
    timestamp: 1789000000000,
    up: upInit,
    down: downInit,
  },
];
