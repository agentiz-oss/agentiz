import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1785000000000_init_app_agentiz';
import { up as upWorkerJobs, down as downWorkerJobs } from './umzug/1785000001000_worker_jobs';

export const umzugExports: Migration[] = [
  {
    name: 'init_app_agentiz',
    timestamp: 1785000000000,
    up: upInit,
    down: downInit,
  },
  {
    name: 'worker_jobs',
    timestamp: 1785000001000,
    up: upWorkerJobs,
    down: downWorkerJobs,
  },
];
