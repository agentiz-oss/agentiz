import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1786000000000_init_gitlab_integration';
import { up as upDropLegacy, down as downDropLegacy } from './umzug/1788000000000_drop_legacy_tables';

export const umzugExports: Migration[] = [
  {
    name: 'init_gitlab_integration',
    timestamp: 1786000000000,
    up: upInit,
    down: downInit,
  },
  // Runs after app-agentiz:1787000000000 has copied these tables into the core ones.
  {
    name: 'drop_legacy_tables',
    timestamp: 1788000000000,
    up: upDropLegacy,
    down: downDropLegacy,
  },
];
