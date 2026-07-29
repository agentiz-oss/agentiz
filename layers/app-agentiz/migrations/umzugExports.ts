import type { Migration } from '@nodeknit/app-manager';
import { up as upInit, down as downInit } from './umzug/1785000000000_init_app_agentiz';
import { up as upWorkerJobs, down as downWorkerJobs } from './umzug/1785000001000_worker_jobs';
import { up as upOptionalRepo, down as downOptionalRepo } from './umzug/1785000002000_optional_project_repo';
import { up as upAgentWorkers, down as downAgentWorkers } from './umzug/1785000003000_agent_workers';
import {
  up as upTaskSources,
  down as downTaskSources,
} from './umzug/1785000004000_task_sources_and_tracker';
import {
  up as upCommentSync,
  down as downCommentSync,
} from './umzug/1785000005000_task_comment_sync';
import {
  up as upWorkerProvisioning,
  down as downWorkerProvisioning,
} from './umzug/1785000006000_worker_admin_provisioning';

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
  {
    name: 'task_sources_and_tracker',
    timestamp: 1785000004000,
    up: upTaskSources,
    down: downTaskSources,
  },
  {
    name: 'task_comment_sync',
    timestamp: 1785000005000,
    up: upCommentSync,
    down: downCommentSync,
  },
  {
    name: 'worker_admin_provisioning',
    timestamp: 1785000006000,
    up: upWorkerProvisioning,
    down: downWorkerProvisioning,
  },
];
