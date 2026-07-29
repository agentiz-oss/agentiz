import { GitHubProvider } from '../git/GitHubProvider';
import { TaskManagerProvider } from './TaskManagerProvider';
import type {
  CommentResult,
  ListTaskManagerTasksParams,
  NormalizedExternalComment,
  NormalizedExternalTask,
  TaskManagerAdapter,
  TaskManagerConfig,
  TaskManagerCredentials,
} from './TaskManagerProvider';

/**
 * GitHub Issues as a task source.
 *
 * It delegates to GitHubProvider rather than re-implementing the REST calls: the issue half of
 * that class is exactly what a task manager needs, and keeping one HTTP client means a fix to
 * pagination or error handling lands in both roles at once. The commit/PR half is simply not
 * exposed here — a project can read tasks from GitHub and push code somewhere else entirely.
 */
export class GitHubIssuesTaskManager extends TaskManagerProvider {
  private readonly provider: GitHubProvider;

  constructor(config: TaskManagerConfig, credentials: TaskManagerCredentials) {
    super('github', config, credentials);
    const owner = String(config.owner ?? '');
    const repo = String(config.repo ?? '');
    if (!owner || !repo) {
      throw new Error('GitHub task source requires "owner" and "repo"');
    }
    if (!credentials.token) {
      throw new Error('GitHub task source requires a token');
    }
    this.provider = new GitHubProvider(
      'github',
      { owner, repo, baseUrl: config.baseUrl ? String(config.baseUrl) : undefined },
      { token: credentials.token, authScheme: 'bearer' },
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

export const githubIssuesTaskManagerAdapter: TaskManagerAdapter = {
  type: 'github',
  title: 'GitHub Issues',
  description: 'Задачи из issues репозитория GitHub (или GitHub Enterprise).',
  supportsWriteback: true,
  supportsComments: true,
  configFields: [
    { key: 'owner', title: 'Владелец (owner)', kind: 'text', required: true, placeholder: 'nodeknit' },
    { key: 'repo', title: 'Репозиторий', kind: 'text', required: true, placeholder: 'demo-repo' },
    {
      key: 'baseUrl',
      title: 'API URL',
      kind: 'text',
      placeholder: 'https://api.github.com',
      hint: 'Заполняется только для GitHub Enterprise',
    },
    { key: 'token', title: 'Токен доступа', kind: 'secret', required: true, hint: 'PAT со scope repo' },
  ],
  create: (config, credentials) => new GitHubIssuesTaskManager(config, credentials),
};
