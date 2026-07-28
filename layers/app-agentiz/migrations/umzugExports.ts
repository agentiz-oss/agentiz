import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1785000000000_init_app_agentiz';
import { up as upWorkerJobs, down as downWorkerJobs } from './umzug/1785000001000_worker_jobs';
import { up as upOptionalRepo, down as downOptionalRepo } from './umzug/1785000002000_optional_project_repo';
import { up as upAgentWorkers, down as downAgentWorkers } from './umzug/1785000003000_agent_workers';

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
  {
    name: 'optional_project_repo',
    timestamp: 1785000002000,
    up: upOptionalRepo,
    down: downOptionalRepo,
  },
  {
    name: 'agent_workers',
    timestamp: 1785000003000,
    up: upAgentWorkers,
    down: downAgentWorkers,
  },
];
