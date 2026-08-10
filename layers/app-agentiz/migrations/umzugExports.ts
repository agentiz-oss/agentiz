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
import {
  up as upRunLogProjectScope,
  down as downRunLogProjectScope,
} from './umzug/1785000007000_run_log_project_scope';
import {
  up as upRepairEmptySpecs,
  down as downRepairEmptySpecs,
} from './umzug/1785000008000_repair_empty_pipeline_specs';
import {
  up as upRunConversationLineage,
  down as downRunConversationLineage,
} from './umzug/1785000009000_run_conversation_lineage';
import {
  up as upPipelineWorkerWorkspace,
  down as downPipelineWorkerWorkspace,
} from './umzug/1785000010000_pipeline_worker_workspace';
import {
  up as upGenericRepositories,
  down as downGenericRepositories,
} from './umzug/1787000000000_generic_repositories';
import {
  up as upWorkerRepositoryScope,
  down as downWorkerRepositoryScope,
} from './umzug/1787000100000_worker_repository_scope';
import {
  up as upTaskBranchRef,
  down as downTaskBranchRef,
} from './umzug/1787000200000_task_branch_ref';
import {
  up as upRunDiffs,
  down as downRunDiffs,
} from './umzug/1787000300000_run_diffs';
import {
  up as upWorkspaceGitReview,
  down as downWorkspaceGitReview,
} from './umzug/1787000400000_workspace_git_review';
import {
  up as upRunInteractions,
  down as downRunInteractions,
} from './umzug/1787000500000_run_interactions';
import {
  up as upWorkerGitPushRoots,
  down as downWorkerGitPushRoots,
} from './umzug/1787000600000_worker_git_push_roots';
import {
  up as upWorkspaceProposalOptionalRepository,
  down as downWorkspaceProposalOptionalRepository,
} from './umzug/1787000700000_workspace_proposal_optional_repository';

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
  {
    name: 'run_log_project_scope',
    timestamp: 1785000007000,
    up: upRunLogProjectScope,
    down: downRunLogProjectScope,
  },
  {
    name: 'repair_empty_pipeline_specs',
    timestamp: 1785000008000,
    up: upRepairEmptySpecs,
    down: downRepairEmptySpecs,
  },
  {
    name: 'run_conversation_lineage',
    timestamp: 1785000009000,
    up: upRunConversationLineage,
    down: downRunConversationLineage,
  },
  {
    name: 'pipeline_worker_workspace',
    timestamp: 1785000010000,
    up: upPipelineWorkerWorkspace,
    down: downPipelineWorkerWorkspace,
  },
  // Deliberately numbered after the GitLab layer's 1786000000000: it copies that layer's data.
  {
    name: 'generic_repositories',
    timestamp: 1787000000000,
    up: upGenericRepositories,
    down: downGenericRepositories,
  },
  {
    name: 'worker_repository_scope',
    timestamp: 1787000100000,
    up: upWorkerRepositoryScope,
    down: downWorkerRepositoryScope,
  },
  {
    name: 'task_branch_ref',
    timestamp: 1787000200000,
    up: upTaskBranchRef,
    down: downTaskBranchRef,
  },
  {
    name: 'run_diffs',
    timestamp: 1787000300000,
    up: upRunDiffs,
    down: downRunDiffs,
  },
  {
    name: 'workspace_git_review',
    timestamp: 1787000400000,
    up: upWorkspaceGitReview,
    down: downWorkspaceGitReview,
  },
  {
    name: 'run_interactions',
    timestamp: 1787000500000,
    up: upRunInteractions,
    down: downRunInteractions,
  },
  {
    name: 'worker_git_push_roots',
    timestamp: 1787000600000,
    up: upWorkerGitPushRoots,
    down: downWorkerGitPushRoots,
  },
  {
    name: 'workspace_proposal_optional_repository',
    timestamp: 1787000700000,
    up: upWorkspaceProposalOptionalRepository,
    down: downWorkspaceProposalOptionalRepository,
  },
];
