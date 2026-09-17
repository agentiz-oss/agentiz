import type { AppManager } from '@nodeknit/app-manager';

/**
 * Neutral demo data for taking mobile-client screenshots (Google Play listing, README, etc.).
 *
 * Off by default — set `AGENTIZ_SEED_MOBILE_SCREENSHOTS=1` to run it. It is meant for a throwaway
 * local instance (own sqlite file, own port), never for a shared dev database: the three projects
 * below are small open-source-flavoured apps invented for this purpose (no client names, no real
 * repositories), so a screenshot taken against them is safe to publish. See
 * `mobile-client/screenshots/README.md` for the full recipe (bootstrap the instance, run these
 * tasks for real through the in-process stub worker, then screenshot the mobile client against it).
 *
 * Same shape as `agentiz-projects.seed.ts`: every project gets an `ownerId` (the mobile API scopes
 * `GET /projects` to the caller's own projects) and roles whose executor is `stub`, so a task can
 * go from `new` to `succeeded` on a bare checkout — no model credentials, no repository token.
 * One task per project is deliberately routed through an unregistered executor kind
 * (`config: { executor: 'offline-only' }`) instead of `stub`: `resolveAgentExecutor` throws for an
 * unknown kind, which is a real, legitimate way to end up with a `failed` run for a screenshot —
 * better than hand-editing a run's status, which would leave its stages inconsistent with it.
 */

interface RoleDef {
  key: string;
  title: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  executor?: string;
}

interface TaskDef {
  externalId: string;
  title: string;
  description: string;
  tags?: string[];
  /** A human follow-up comment to seed on this task, for the discussion-thread screenshot. */
  comment?: string;
}

interface ProjectDef {
  slug: string;
  name: string;
  description: string;
  repo: { owner: string; repo: string; defaultBranch: string };
  roles: RoleDef[];
  stages: Array<{ role: string; agentRoleKey: string }>;
  tasks: TaskDef[];
  /** A second, tag-matched pipeline that fails on purpose — see the file header. */
  failingTag?: { tag: string; role: RoleDef };
}

const INVESTIGATOR: RoleDef = {
  key: 'investigator',
  title: 'Расследователь',
  systemPrompt: 'Изучи задачу и опиши, что нужно проверить и где именно. Ничего не меняй.',
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
    slug: 'weather-now',
    name: 'Weather Now',
    description: 'Небольшое погодное приложение с открытым исходным кодом: текущая погода, осадки, виджет.',
    repo: { owner: 'demo-oss', repo: 'weather-now', defaultBranch: 'main' },
    roles: [INVESTIGATOR, DECIDER, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'decide', agentRoleKey: 'decider' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
    tasks: [
      {
        externalId: '101',
        title: 'Температура показывается в °F для пользователей из Великобритании',
        description:
          'Приложение определяет регион по локали устройства, но для en-GB всё равно показывает ' +
          'Фаренгейты вместо Цельсия. Нужно завязать единицы измерения на страну, а не на язык.',
      },
      {
        externalId: '102',
        title: 'Добавить тёмную тему в настройки',
        description:
          'Сейчас приложение всегда светлое. Нужен переключатель «Тёмная / Светлая / Как в системе» ' +
          'на экране настроек и сохранение выбора между запусками.',
      },
      {
        externalId: '103',
        title: 'Нестабильный снапшот-тест графика влажности ломает сборку',
        description:
          'graph_humidity_test падает через раз на CI: расхождение в один пиксель на границе графика. ' +
          'Нужно разобраться, антиалиасинг это или гонка в рендере перед снятием снапшота.',
        tags: ['ci-flake'],
      },
    ],
    failingTag: {
      tag: 'ci-flake',
      role: { ...INVESTIGATOR, key: 'offline-investigator', executor: 'offline-only' },
    },
  },
  {
    slug: 'recipe-box',
    name: 'Recipe Box',
    description: 'Каталог рецептов с тегами, списком покупок и заметками — держим его открытым и простым.',
    repo: { owner: 'demo-oss', repo: 'recipe-box', defaultBranch: 'main' },
    roles: [INVESTIGATOR, DECIDER, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'decide', agentRoleKey: 'decider' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
    tasks: [
      {
        externalId: '201',
        title: 'Поиск показывает рецепт дважды при фильтре по тегу',
        description:
          'Если у рецепта два совпавших тега из фильтра, он попадает в выдачу поиска два раза. ' +
          'Похоже, join по тегам не дедуплицируется перед сортировкой по релевантности.',
      },
      {
        externalId: '202',
        title: 'Переключатель метрических/имперских единиц для ингредиентов',
        description:
          'Часть рецептов в граммах и миллилитрах, часть — в чашках и унциях. Нужен один тумблер в ' +
          'настройках, который на лету пересчитывает количество во всех открытых рецептах.',
        comment:
          'Уточнение от продукта: пересчёт только для отображения, исходное значение рецепта менять ' +
          'нельзя — иначе разъедутся рецепты, которыми уже поделились по ссылке.',
      },
      {
        externalId: '203',
        title: 'Фото рецепта не сжимается перед загрузкой',
        description:
          'Фото с телефона (12+ Мп) заливаются как есть, лента рецептов грузится по 8–10 секунд ' +
          'на мобильной сети. Нужно ужать до разумного размера на клиенте перед отправкой.',
      },
    ],
  },
  {
    slug: 'trailhead',
    name: 'Trailhead',
    description: 'Трекер пеших маршрутов: запись GPS-трека, офлайн-карты, заметки о тропе.',
    repo: { owner: 'demo-oss', repo: 'trailhead', defaultBranch: 'main' },
    roles: [INVESTIGATOR, REPORTER],
    stages: [
      { role: 'investigate', agentRoleKey: 'investigator' },
      { role: 'report', agentRoleKey: 'reporter' },
    ],
    tasks: [
      {
        externalId: '301',
        title: 'Экспорт в GPX даёт битый файл для маршрутов с паузами',
        description:
          'Если во время записи маршрута была пауза (привал), выгруженный GPX не проходит валидацию ' +
          'в внешних картах — вероятно, точка возобновления записывается с нулевым таймстампом.',
      },
      {
        externalId: '302',
        title: 'Офлайн-кэш карт для популярных маршрутов',
        description:
          'Сейчас карта пропадает без сети. Нужно кэшировать тайлы вдоль сохранённых маршрутов ' +
          'заранее, по кнопке «Скачать для офлайна» на экране маршрута.',
      },
    ],
  },
];

async function firstAdminId(appManager: AppManager): Promise<number | null> {
  const sequelize = appManager.sequelize;
  if (!sequelize.isDefined('UserAP')) return null;
  const UserAP = sequelize.model('UserAP');
  const admin = await UserAP.findOne({ order: [['id', 'ASC']] });
  const id = admin?.get('id');
  return typeof id === 'number' ? id : id != null ? Number(id) : null;
}

export async function seed(appManager: AppManager) {
  if (process.env.AGENTIZ_SEED_MOBILE_SCREENSHOTS !== '1') return;

  const models = appManager.sequelize.models;
  const projectModel = models.AgentProject;
  const roleModel = models.AgentRole;
  const specModel = models.PipelineSpec;
  const taskModel = models.AgentTask;
  const commentModel = models.AgentTaskComment;

  if (!projectModel || !roleModel || !specModel || !taskModel || !commentModel) {
    console.warn('[mobile-screenshots.seed] Agentiz models not found, skipping');
    return;
  }

  const ownerId = await firstAdminId(appManager);
  if (ownerId == null) {
    console.warn('[mobile-screenshots.seed] No administrator yet — skipping (create one, then restart)');
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
      console.log(`[mobile-screenshots.seed] Project created: ${def.name}`);
    } else {
      await project.update(projectAttrs);
    }
    const projectId = project.get('id');

    const allRoles = def.failingTag ? [...def.roles, def.failingTag.role] : def.roles;
    for (const role of allRoles) {
      const attrs = {
        key: role.key,
        title: role.title,
        systemPrompt: role.systemPrompt,
        model: role.model,
        allowedTools: role.allowedTools,
        config: { executor: role.executor ?? 'stub' },
        projectId,
      };
      const existing = await roleModel.findOne({ where: { projectId, key: role.key } });
      if (!existing) {
        await roleModel.create(attrs);
      } else {
        await existing.update(attrs);
      }
    }

    const defaultSpec = {
      name: 'Default pipeline',
      matchTags: null as string[] | null,
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
        finalAction: { type: 'none' },
      },
      projectId,
    };
    const existingDefault = await specModel.findOne({ where: { projectId, name: defaultSpec.name } });
    if (!existingDefault) {
      await specModel.create(defaultSpec);
    } else {
      await existingDefault.update(defaultSpec);
    }

    if (def.failingTag) {
      const failingSpec = {
        name: 'CI flake triage (offline)',
        matchTags: [def.failingTag.tag],
        isDefault: false,
        isActive: true,
        version: 1,
        spec: {
          stages: [
            {
              order: 1,
              role: 'investigate',
              agentRoleKey: def.failingTag.role.key,
              onFail: 'stop',
              runtime: { mode: 'host' },
            },
          ],
          finalAction: { type: 'none' },
        },
        projectId,
      };
      const existingFailing = await specModel.findOne({ where: { projectId, name: failingSpec.name } });
      if (!existingFailing) {
        await specModel.create(failingSpec);
      } else {
        await existingFailing.update(failingSpec);
      }
    }

    for (const task of def.tasks) {
      let taskRow: any = await taskModel.findOne({ where: { projectId, externalId: task.externalId } });
      if (!taskRow) {
        taskRow = await taskModel.create({
          projectId,
          externalId: task.externalId,
          externalUrl: `https://github.com/${def.repo.owner}/${def.repo.repo}/issues/${task.externalId}`,
          title: task.title,
          description: task.description,
          tags: task.tags ?? null,
          externalStatus: 'open',
          status: 'new',
        });
        console.log(`[mobile-screenshots.seed] ${def.slug}: task #${task.externalId}`);
      }

      if (task.comment) {
        const existingComment = await commentModel.findOne({
          where: { taskId: taskRow.get('id'), authorKind: 'human', origin: 'local' },
        });
        if (!existingComment) {
          await commentModel.create({
            taskId: taskRow.get('id'),
            authorKind: 'human',
            authorName: 'Продакт-менеджер',
            authorId: ownerId,
            body: task.comment,
            origin: 'local',
          });
        }
      }
    }
  }

  console.log('[mobile-screenshots.seed] Done. Run the tasks for real from the panel, then screenshot the mobile client.');
}
