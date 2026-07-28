import type { AppManager } from '@nodeknit/app-manager';

/**
 * Demo data for app-agentiz: one project with four agent roles and two pipeline specs
 * (a tag-specific "bugfix" pipeline and a project-wide default), plus a local task so the
 * pipeline can be exercised without a live tracker connection.
 */
export async function seed(appManager: AppManager) {
  const models = appManager.sequelize.models;
  const projectModel = models.AgentProject;
  const roleModel = models.AgentRole;
  const specModel = models.PipelineSpec;
  const taskModel = models.AgentTask;

  if (!projectModel || !roleModel || !specModel || !taskModel) {
    console.warn('[agentiz.seed] Agentiz models not found, skipping');
    return;
  }

  const slug = 'demo-repo';
  let project: any = await projectModel.findOne({ where: { slug } });
  if (!project) {
    project = await projectModel.create({
      name: 'Demo Repo',
      slug,
      description: 'Демо-проект agentiz: issues из GitHub, пайплайн investigate → decide → fix → commit.',
      repoProvider: 'github',
      repoConfig: { owner: 'nodeknit', repo: 'demo-repo', defaultBranch: 'main' },
      trackerConfig: { pollIntervalSec: 600, query: { state: 'open' } },
      secrets: {},
      isActive: true,
    });
    console.log('[agentiz.seed] Project created: Demo Repo');
  }

  const roles = [
    {
      key: 'investigator',
      title: 'Расследователь',
      systemPrompt: 'Изучи задачу и репозиторий. Опиши воспроизведение, затронутые файлы и вероятную причину. Ничего не меняй.',
      model: 'claude-sonnet-5',
      allowedTools: ['Read', 'Grep', 'Glob'],
      config: { executor: 'stub' },
    },
    {
      key: 'decider',
      title: 'Принимающий решение',
      systemPrompt: 'На основе результатов расследования выбери план исправления и обоснуй его. Правки не вносишь.',
      model: 'claude-opus-4-8',
      allowedTools: ['Read'],
      config: { executor: 'stub' },
    },
    {
      key: 'fixer',
      title: 'Исправляющий',
      systemPrompt: 'Реализуй выбранный план: внеси правки в код и подготовь описание изменений.',
      model: 'claude-sonnet-5',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
      config: { executor: 'stub' },
    },
    {
      key: 'committer',
      title: 'Коммитер',
      systemPrompt: 'Собери финальный набор изменений и текст коммита.',
      model: 'claude-haiku-4-5-20251001',
      allowedTools: ['Read'],
      config: { executor: 'stub' },
    },
  ];

  for (const role of roles) {
    const existing = await roleModel.findOne({ where: { projectId: project.get('id'), key: role.key } });
    if (!existing) {
      await roleModel.create({ ...role, projectId: project.get('id') });
      console.log(`[agentiz.seed] Role created: ${role.key}`);
    } else if (process.env.NODE_ENV !== 'production') {
      await existing.update(role);
    }
  }

  const specs: Array<Record<string, unknown>> = [
    {
      name: 'Bugfix pipeline',
      matchTags: ['bug', 'defect'],
      isDefault: false,
      isActive: true,
      version: 1,
      spec: {
        stages: [
          { order: 1, role: 'investigate', agentRoleKey: 'investigator', onFail: 'stop' },
          { order: 2, role: 'decide', agentRoleKey: 'decider', onFail: 'stop' },
          { order: 3, role: 'fix', agentRoleKey: 'fixer', onFail: 'stop' },
          { order: 4, role: 'commit', agentRoleKey: 'committer', onFail: 'stop' },
        ],
        finalAction: {
          type: 'commit_and_pr',
          branchPrefix: 'agentiz/bug-',
          commitMessageTemplate: 'fix: {{title}} (#{{externalId}})',
          pullRequestTitleTemplate: 'fix: {{title}}',
        },
      },
    },
    {
      // Fallback for tasks no tag-specific spec claims: analyse only, never touch the repository.
      name: 'Default pipeline',
      matchTags: null,
      isDefault: true,
      isActive: true,
      version: 1,
      spec: {
        stages: [
          { order: 1, role: 'investigate', agentRoleKey: 'investigator', onFail: 'stop' },
          { order: 2, role: 'decide', agentRoleKey: 'decider', onFail: 'stop' },
        ],
        finalAction: { type: 'none' },
      },
    },
  ];

  for (const spec of specs) {
    const existing = await specModel.findOne({ where: { projectId: project.get('id'), name: spec.name } });
    if (!existing) {
      await specModel.create({ ...spec, projectId: project.get('id') });
      console.log(`[agentiz.seed] Pipeline spec created: ${spec.name}`);
    } else if (process.env.NODE_ENV !== 'production') {
      await existing.update(spec);
    }
  }

  const demoTasks = [
    {
      // tag "bug" routes this one to the Bugfix pipeline (commit_and_pr => needs a real repo token).
      externalId: '1',
      externalUrl: 'https://github.com/nodeknit/demo-repo/issues/1',
      title: 'Отчёт по продажам падает на пустом дне',
      description: 'При запросе отчёта за день без продаж сервис возвращает 500 вместо пустого отчёта.',
      tags: ['bug'],
    },
    {
      // No matching tag => Default pipeline, finalAction=none, so it runs green without credentials.
      externalId: '2',
      externalUrl: 'https://github.com/nodeknit/demo-repo/issues/2',
      title: 'Как настроить выгрузку во внешнюю систему?',
      description: 'Вопрос от пользователя, нужен разбор без правок кода.',
      tags: ['question'],
    },
  ];

  for (const task of demoTasks) {
    const existing = await taskModel.findOne({
      where: { projectId: project.get('id'), externalId: task.externalId },
    });
    if (!existing) {
      await taskModel.create({
        ...task,
        projectId: project.get('id'),
        externalStatus: 'open',
        status: 'new',
      });
      console.log(`[agentiz.seed] Demo task created: #${task.externalId}`);
    }
  }
}
