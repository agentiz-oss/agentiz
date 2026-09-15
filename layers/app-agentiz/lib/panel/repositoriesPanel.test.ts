import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentGitConnection } from '../../models/AgentGitConnection';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { registerGitProviderPanel, unregisterGitProviderPanel } from '../git';
import { configureRouteTree } from './routeTree';
import { gitProviderDetail, gitProvidersOverview, projectRepositoryRows } from './repositoriesPanel';

/**
 * Three things this file exists to keep true, and each of them has already gone wrong somewhere in
 * this repository:
 *
 * 1. **No secret leaves.** The webhook column holds the delivery secret we issued to the platform
 *    and a connection holds its tokens; both travel close to a screen here.
 * 2. **No hook is a state with a reason, not an error.** The row must carry the reason instead of
 *    looking installed or looking broken.
 * 3. **The platform list comes from the collection, not from a name spelled in the core.** Which
 *    also means an unmounted layer hides its buttons and not its connections.
 */
describe('repositoriesPanel', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let other: AgentProject;
  let connection: AgentGitConnection;

  const PANEL = {
    provider: 'gitlab' as const,
    title: 'GitLab',
    summary: 'OAuth-приложение GitLab.',
    apiRoute: '/agentiz-gitlab',
    appIdentityField: 'applicationId',
    appHint: 'User → Applications',
    defaultScopes: ['api'],
    appFields: [{ name: 'applicationId', label: 'Application ID', required: true }],
  };

  async function mirror(path: string, webhook: any = null) {
    return AgentRepository.create({
      connectionId: connection.id,
      provider: 'gitlab',
      externalRepoId: path,
      pathWithNamespace: path,
      owner: path.split('/')[0],
      repo: path.split('/')[1],
      cloneUrl: `git@git.example:${path}.git`,
      defaultBranch: 'main',
      webhook,
      watchCursor: { branchHeads: { main: 'cdff4f4aaaa', release: 'bbb' }, checkedAt: '2026-09-14T10:00:00.000Z' },
    } as any);
  }

  async function link(target: AgentProject, repository: AgentRepository) {
    return AgentProjectRepository.create({
      projectId: target.id,
      provider: 'gitlab',
      connectionId: connection.id,
      repositoryId: repository.id,
      role: 'both',
      isActive: true,
    } as any);
  }

  beforeEach(async () => {
    configureRouteTree('/dashboard/agentiz');
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });

    project = await AgentProject.create({ name: 'Мой', slug: 'mine', ownerId: 1 } as any);
    other = await AgentProject.create({ name: 'Чужой', slug: 'theirs', ownerId: 2 } as any);
    connection = await AgentGitConnection.create({
      provider: 'gitlab',
      baseUrl: 'https://git.example',
      username: 'vibes',
      scope: 'api read_repository',
      status: 'active',
      secrets: { accessToken: 'ТОКЕН', refreshToken: 'ОБНОВИТЬ' },
    } as any);
  });

  afterEach(() => {
    unregisterGitProviderPanel('gitlab');
  });

  it('never lets a webhook secret or a connection token onto a screen', async () => {
    const repository = await mirror('vibes/lyapka', {
      hookId: '42', endpointId: 'e1', url: 'https://agentiz/api/hooks/v1/e1',
      secret: 'ЭТО-НЕ-ДОЛЖНО-УЕХАТЬ', installedAt: '2026-09-01T00:00:00.000Z', events: ['push'],
    });
    await link(project, repository);
    registerGitProviderPanel(PANEL);

    const rows = await projectRepositoryRows([project.id]);
    const providers = await gitProvidersOverview();

    // Serialized whole, the way the page props actually travel — a field added later has to fail
    // this too, which a per-field assertion would not catch.
    const wire = JSON.stringify({ rows, providers });
    expect(wire).not.toContain('ЭТО-НЕ-ДОЛЖНО-УЕХАТЬ');
    expect(wire).not.toContain('ТОКЕН');
    expect(wire).not.toContain('ОБНОВИТЬ');
    expect(rows[0].webhook).toEqual({
      installed: true,
      url: 'https://agentiz/api/hooks/v1/e1',
      installedAt: '2026-09-01T00:00:00.000Z',
      lastDeliveryAt: null,
      lastError: null,
      events: ['push'],
    });
    // The token is still known to exist — that is the fact a screen needs, not the value.
    expect(providers[0].connections[0].hasSecrets).toBe(true);
  });

  it('reports a missing hook as a state with a reason', async () => {
    const absent = await mirror('vibes/no-hook', { lastError: 'AGENTIZ_PUBLIC_URL не задан' });
    const never = await mirror('vibes/never-tried');
    await link(project, absent);
    await link(project, never);

    const rows = await projectRepositoryRows([project.id]);
    const byPath = new Map(rows.map((row) => [row.repository!.pathWithNamespace, row]));

    expect(byPath.get('vibes/no-hook')!.webhook).toMatchObject({
      installed: false,
      lastError: 'AGENTIZ_PUBLIC_URL не задан',
    });
    // Never attempted at all is a third state and must not read as "installed" or as an error.
    expect(byPath.get('vibes/never-tried')!.webhook).toBeNull();
  });

  it('shows the watch cursor without turning it into a branch list', async () => {
    await link(project, await mirror('vibes/lyapka'));

    const [row] = await projectRepositoryRows([project.id]);

    expect(row.watch).toMatchObject({ branchCount: 2, checkedAt: '2026-09-14T10:00:00.000Z' });
    expect(row.watch!.branches[0]).toEqual({ branch: 'main', sha: 'cdff4f4aaaa' });
  });

  it('takes the last event from the project that saw it, not from the repository', async () => {
    // One repository, two projects: the fact is about the repository, but the feed row is a
    // project's, and each project must be shown its own.
    const repository = await mirror('vibes/shared');
    await link(project, repository);
    await link(other, repository);
    await AgentActivity.create({
      type: 'repository.pushed', kind: 'info', projectId: project.id,
      title: 'vibes/shared: 3 коммита в main', body: '',
      data: { repositoryId: repository.id, branch: 'main' },
    } as any);

    const mine = await projectRepositoryRows([project.id]);
    const theirs = await projectRepositoryRows([other.id]);

    expect(mine[0].lastEvent).toMatchObject({ type: 'repository.pushed', badge: 'коммиты' });
    expect(theirs[0].lastEvent).toBeNull();
  });

  it('builds the platform list from the collection and keeps an undescribed one visible', async () => {
    await link(project, await mirror('vibes/lyapka'));

    const before = await gitProvidersOverview();
    // No layer mounted: the connection is still there, the buttons are not. A screen built from the
    // registry alone would answer «нет подключений» on an installation that has one.
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ provider: 'gitlab', described: false, apiRoute: null });
    expect(before[0].connections).toHaveLength(1);
    expect(before[0].repositoryCount).toBe(1);

    registerGitProviderPanel(PANEL);
    const after = await gitProviderDetail('gitlab');

    expect(after).toMatchObject({
      title: 'GitLab',
      described: true,
      apiRoute: '/agentiz-gitlab',
      appIdentityField: 'applicationId',
      href: '/dashboard/agentiz/integrations/git/gitlab',
    });
    // A descriptor is public data and must stay free of anything write-only: what travels is the
    // *shape* of the application form, never a value from it.
    expect(JSON.stringify(after)).not.toContain('clientSecret');
    expect(await gitProviderDetail('bitbucket')).toBeNull();
  });

  it('carries the whole link config, because an update writes that column as a unit', async () => {
    const repository = await mirror('vibes/lyapka');
    const row = await link(project, repository);
    await row.update({ config: { defaultBranch: 'test2', pollIntervalSec: 600 } });

    const [built] = await projectRepositoryRows([project.id]);

    // The screen edits one key of it; sending only that key back would erase the rest.
    expect(built.config).toEqual({ defaultBranch: 'test2', pollIntervalSec: 600 });
    expect(built.repositoryId).toBe(repository.id);
    expect(built.providerTitle).toBe('gitlab');
  });
});
