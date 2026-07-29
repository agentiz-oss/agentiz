import { GitLabProvider } from './GitLabProvider';
import { TaskManagerProvider } from '../../app-agentiz/lib/taskManager';
import type {
  CommentResult,
  ListTaskManagerTasksParams,
  NormalizedExternalComment,
  NormalizedExternalTask,
  TaskManagerAdapter,
  TaskManagerConfig,
  TaskManagerCredentials,
} from '../../app-agentiz/lib/taskManager';

/**
 * GitLab issues as a generic task source.
 *
 * This is the personal-access-token path, deliberately separate from the OAuth flow this layer
 * also provides: an operator who just wants to read issues out of one repository should not have
 * to register an OAuth application first. Both paths end up in the same place — AgentTask rows
 * carrying `sourceType: 'gitlab'`.
 *
 * It delegates to GitLabProvider so there is exactly one GitLab REST client in the layer.
 */
export class GitlabIssuesTaskManager extends TaskManagerProvider {
  private readonly provider: GitLabProvider;

  constructor(config: TaskManagerConfig, credentials: TaskManagerCredentials) {
    super('gitlab', config, credentials);
    const owner = String(config.owner ?? '');
    const repo = String(config.repo ?? '');
    if (!owner || !repo) {
      throw new Error('GitLab task source requires "owner" (group/namespace) and "repo"');
    }
    if (!credentials.token) {
      throw new Error('GitLab task source requires a token');
    }
    this.provider = new GitLabProvider(
      'gitlab',
      { owner, repo, baseUrl: config.baseUrl ? String(config.baseUrl) : undefined },
      // A PAT goes in PRIVATE-TOKEN; `bearer` is only for OAuth access tokens.
      { token: String(credentials.token), authScheme: credentials.authScheme === 'bearer' ? 'bearer' : 'token' },
    );
  }

  testConnection(): Promise<boolean> {
    return this.provider.testConnection();
  }

  listTasks(params: ListTaskManagerTasksParams): Promise<NormalizedExternalTask[]> {
    return this.provider.listTasks({ updatedSince: params.updatedSince, query: params.query });
  }

  getTask(externalId: string): Promise<NormalizedExternalTask> {
    return this.provider.getTask(externalId);
  }

  updateTaskStatus(externalId: string, status: string): Promise<void> {
    return this.provider.updateTaskStatus(externalId, status);
  }

  commentOnTask(externalId: string, body: string): Promise<CommentResult> {
    return this.provider.commentOnTask(externalId, body);
  }

  listComments(externalId: string): Promise<NormalizedExternalComment[]> {
    return this.provider.listComments(externalId);
  }
}

/** What this layer contributes to app-agentiz's `taskManagers` collection. */
export const gitlabIssuesTaskManagerAdapter: TaskManagerAdapter = {
  type: 'gitlab',
  title: 'GitLab Issues',
  description: 'Задачи из issues проекта GitLab по personal access token (без OAuth).',
  supportsWriteback: true,
  supportsComments: true,
  configFields: [
    {
      key: 'owner',
      title: 'Группа / namespace',
      kind: 'text',
      required: true,
      placeholder: 'my-group',
      hint: 'Для вложенных групп — полный путь, например my-group/subgroup',
    },
    { key: 'repo', title: 'Проект', kind: 'text', required: true, placeholder: 'my-project' },
    {
      key: 'baseUrl',
      title: 'URL GitLab',
      kind: 'text',
      placeholder: 'https://gitlab.com',
      hint: 'Заполняется для self-hosted инсталляций',
    },
    { key: 'token', title: 'Personal access token', kind: 'secret', required: true, hint: 'Scope: api' },
  ],
  create: (config, credentials) => new GitlabIssuesTaskManager(config, credentials),
};
