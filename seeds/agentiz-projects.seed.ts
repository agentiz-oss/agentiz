import type { AppManager } from '@nodeknit/app-manager';

/**
 * Three ready-to-run Agentiz projects for the mobile client.
 *
 * Unlike `agentiz.seed`, every project here is assigned an `ownerId`: the mobile API scopes
 * `GET /projects` to the caller's own projects, so a project without an owner is invisible to the
 * app no matter how well it is configured.
 *
 * Each project carries roles whose executor is `stub` and a default pipeline whose `finalAction`
 * is `none`. That combination is what makes the projects runnable on a bare checkout — no model
 * credentials, no repository token, no tracker — so the in-process worker can take a task from
 * `new` to `succeeded` and write its report into the comment thread.
 *
 * `repoConfig` still has to be filled in even though nothing here touches git:
 * `AgentWorkerJobBuilder.buildSnapshot` resolves a repository for every queued job and throws
 * without one, so a repo-less project can be created but never run. The coordinates below are
 * only recorded in the job snapshot — `finalAction: none` returns before a git provider is ever
 * constructed, so no token is needed and nothing is cloned or pushed.
 */

interface RoleDef {
  key: string;
  title: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
}

interface ProjectDef {
  slug: string;
  name: string;
  description: string;
  /** Nominal repository coordinates; see the file header for why they are required. */
  repo: { owner: string; repo: string; defaultBranch: string };
  roles: RoleDef[];
  /** Stage list of the project's default pipeline, in execution order. */
  stages: Array<{ role: string; agentRoleKey: string }>;
}

const ANALYST: RoleDef = {
  key: 'investigator',
  title: 'Расследователь',
  systemPrompt: 'Изучи задачу и опиши, что именно нужно проверить и где. Ничего не меняй.',
  model: 'claude-sonnet-5',
  allowedTools: ['Read', 'Grep', 'Glob'],
};

const DECIDER: RoleDef = {
  key: 'decider',
  title: 'Принимающий решение',
  systemPrompt: 'На основе расследования выбери план действий и обоснуй его. Правки не вносишь.',
  model: 'claude-opus-5',
  allowedTools: ['Read'],
};

const REPORTER: RoleDef = {
  key: 'reporter',
  title: 'Докладчик',
  systemPrompt: 'Собери итог работы предыдущих стадий в короткий отчёт для человека.',
  model: 'claude-haiku-4-5-20251001',
  allowedTools: ['Read'],
};

const PROJECTS: ProjectDef[] = [
  {
    slug: 'billing',
    name: 'Биллинг',
    description: 'Тарифы, счета и выставление платежей. Задачи приходят из внутреннего трекера.',
    repo: { owner: 'nodeknit', repo: 'billing', defaultBranch: 'main' },
    roles: [ANALYST, DECIDER, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'decide', agentRoleKey: 'decider' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
  },
  {
    slug: 'mobile-app',
    name: 'Мобильное приложение',
    description: 'Клиент Agentiz для Android, iOS, десктопа и браузера.',
    repo: { owner: 'nodeknit', repo: 'agentiz-client', defaultBranch: 'main' },
    roles: [ANALYST, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
  },
  {
    slug: 'infra',
    name: 'Инфраструктура',
    description: 'Сборки, деплой и мониторинг. Пайплайн только анализирует, ничего не выкатывает.',
    repo: { owner: 'nodeknit', repo: 'infra', defaultBranch: 'main' },
    roles: [ANALYST, DECIDER, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'decide', agentRoleKey: 'decider' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
  },
];

/**
 * The projects are handed to the first administrator. Seeds run on every boot, well before anyone
 * has opened the panel on a fresh database, so "no admin yet" is an ordinary outcome and not an
 * error — the seed simply defers until an admin exists.
 */
async function firstAdminId(appManager: AppManager): Promise<number | null> {
  const sequelize = appManager.sequelize;
  if (!sequelize.isDefined('UserAP')) return null;
  const UserAP = sequelize.model('UserAP');
  const admin = await UserAP.findOne({ order: [['id', 'ASC']] });
  const id = admin?.get('id');
  return typeof id === 'number' ? id : id != null ? Number(id) : null;
}

export async function seed(appManager: AppManager) {
  const models = appManager.sequelize.models;
  const projectModel = models.AgentProject;
  const roleModel = models.AgentRole;
  const specModel = models.PipelineSpec;

  if (!projectModel || !roleModel || !specModel) {
    console.warn('[agentiz-projects.seed] Agentiz models not found, skipping');
    return;
  }

  const ownerId = await firstAdminId(appManager);
  if (ownerId == null) {
    console.warn('[agentiz-projects.seed] No administrator yet — skipping (create one, then restart)');
    return;
  }

  for (const def of PROJECTS) {
    const projectAttrs = {
      name: def.name,
      slug: def.slug,
      description: def.description,
      repoProvider: 'github',
      repoConfig: def.repo,
      trackerConfig: {},
      isActive: true,
      ownerId,
    };

    let project: any = await projectModel.findOne({ where: { slug: def.slug } });
    if (!project) {
      project = await projectModel.create({ ...projectAttrs, secrets: {} });
      console.log(`[agentiz-projects.seed] Project created: ${def.name}`);
    } else if (process.env.NODE_ENV !== 'production') {
      // Refresh in place rather than creating a duplicate slug: an earlier run may have left the
      // project unowned (invisible to the mobile client) or without the repoConfig a queued job
      // needs. `secrets` is left alone so a token added by hand survives a reseed.
      await project.update(projectAttrs);
    }

    const projectId = project.get('id');

    for (const role of def.roles) {
      const attrs = { ...role, config: { executor: 'stub' }, projectId };
      const existing = await roleModel.findOne({ where: { projectId, key: role.key } });
      if (!existing) {
        await roleModel.create(attrs);
        console.log(`[agentiz-projects.seed] ${def.slug}: role ${role.key}`);
      } else if (process.env.NODE_ENV !== 'production') {
        await existing.update(attrs);
      }
    }

    const specAttrs = {
      name: 'Default pipeline',
      // No matchTags: this is the catch-all every task of the project resolves to.
      matchTags: null,
      isDefault: true,
      isActive: true,
      version: 1,
      spec: {
        stages: def.stages.map((stage, index) => ({
          order: index + 1,
          role: stage.role,
          agentRoleKey: stage.agentRoleKey,
          onFail: 'stop',
          runtime: { mode: 'host' },
        })),
        // `none` keeps the run entirely inside Agentiz: no branch, no PR, no tracker call.
        finalAction: { type: 'none' },
      },
      projectId,
    };
    const existingSpec = await specModel.findOne({ where: { projectId, name: specAttrs.name } });
    if (!existingSpec) {
      await specModel.create(specAttrs);
      console.log(`[agentiz-projects.seed] ${def.slug}: pipeline "${specAttrs.name}"`);
    } else if (process.env.NODE_ENV !== 'production') {
      await existingSpec.update(specAttrs);
    }
  }
}
