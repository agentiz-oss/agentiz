import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../models';
import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentRunJob } from '../../models/AgentRunJob';
import { AgentRunLog } from '../../models/AgentRunLog';
import { AgentStageExecution } from '../../models/AgentStageExecution';
import { AgentTask } from '../../models/AgentTask';
import { AgentActivity } from '../../models/AgentActivity';
import { AgentApprovalRequest } from '../../models/AgentApprovalRequest';
import { AgentRunInteraction } from '../../models/AgentRunInteraction';
import { AgentTaskComment } from '../../models/AgentTaskComment';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';
import { PipelineSpec } from '../../models/PipelineSpec';
import { assertValidSpec } from '../../services/PipelineSpecValidation';
import { collectInboxItems } from '../inbox/collect';
import { DEMO_PROJECT_SLUG, removeDemoWorkspaceContent, seedDemoWorkspace } from './demoWorkspace';

/**
 * Демо-проект для ревью в магазинах.
 *
 * Проверяется не «красиво ли получилось», а три свойства, каждое из которых ломается молча и
 * обнаруживается только ревьюером Apple или Google:
 *
 * 1. Экран ревьюера **не пустой** и во входящих лежит именно то, что он может закрыть руками —
 *    вопрос агента и заявка на приёмку.
 * 2. Повторный вызов **ничего не удваивает**: инструмент вызывают перед каждой отправкой, и
 *    вторая копия каждой задачи — это ровно то, чего от «идемпотентно» ждут и не получают.
 * 3. Демо **не оживает само**: записи очереди лежат в `succeeded`, иначе `AgentJobReaperService`
 *    через четверть часа осиротит вопрос агента, и блокирующая строка исчезнет сама собой.
 *
 * Плюс граница: удаление демо не трогает соседний проект — инструмент ходит на прод, где рядом
 * живут настоящие данные.
 */
describe('демо-проект для проверки в App Store / Google Play', () => {
  let sequelize: Sequelize;
  const OWNER = 7;

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite', storage: ':memory:', logging: false,
      models: Object.values(agentizModels) as any[],
    });
    await sequelize.sync({ force: true });
  });

  it('даёт ревьюеру непустой экран: проект, задачи, запуски и две строки, которые можно закрыть', async () => {
    const result = await seedDemoWorkspace({ ownerUserId: OWNER, now: new Date('2026-09-17T12:00:00Z') });

    const project = await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } });
    expect(project).not.toBeNull();
    expect(project!.ownerId).toBe(OWNER);
    expect(result.counts.tasks).toBeGreaterThanOrEqual(6);

    const [tasks, runs, stages, logs] = await Promise.all([
      AgentTask.count({ where: { projectId: project!.id } }),
      AgentRun.count({ where: { projectId: project!.id } }),
      AgentStageExecution.count(),
      AgentRunLog.count(),
    ]);
    expect(tasks).toBe(result.counts.tasks);
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(stages).toBeGreaterThan(0);
    expect(logs).toBeGreaterThan(0);

    // Разные статусы задач — иначе доска выглядит как одна колонка.
    const statuses = new Set((await AgentTask.findAll()).map((task) => task.status));
    expect(statuses).toEqual(new Set(['new', 'done', 'failed', 'waiting_input', 'waiting_review']));

    const inbox = await collectInboxItems({ projectIds: [project!.id], actor: OWNER });
    const kinds = inbox.items.map((item) => item.kind);
    expect(kinds).toContain('question');
    expect(kinds).toContain('approval');
    // Напоминания тоже есть, и они специально не блокирующие.
    expect(kinds).toContain('run_failed');
    expect(kinds).toContain('pr');
  }, 30_000);

  it('данные демо — английские: их читает ревьюер магазина, а не наш пользователь', async () => {
    await seedDemoWorkspace({ ownerUserId: OWNER });

    // Интерфейс приложения остаётся русским (строки зашиты в клиент), но всё, что приходит из этой
    // таблицы, ревьюер Apple или Google должен прочитать. Сторож стоит здесь, потому что следующая
    // добавленная задача напишется по-русски не задумываясь, а увидит это только ревьюер.
    const cyrillic = /[А-Яа-яЁё]/;
    const offenders: string[] = [];
    const check = (where: string, value: unknown) => {
      if (typeof value === 'string' && cyrillic.test(value)) offenders.push(`${where}: ${value.slice(0, 60)}`);
    };

    const project = await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } });
    check('project.name', project!.name);
    check('project.description', project!.description);
    for (const task of await AgentTask.findAll({ where: { projectId: project!.id } })) {
      check(`task ${task.id}.title`, task.title);
      check(`task ${task.id}.description`, task.description);
    }
    for (const run of await AgentRun.findAll({ where: { projectId: project!.id } })) {
      check(`run ${run.id}.resultSummary`, run.resultSummary);
      check(`run ${run.id}.errorMessage`, run.errorMessage);
    }
    for (const stage of await AgentStageExecution.findAll()) {
      check(`stage ${stage.id}.output`, JSON.stringify(stage.output));
      check(`stage ${stage.id}.errorMessage`, stage.errorMessage);
    }
    for (const line of await AgentRunLog.findAll()) check(`log ${line.id}`, line.message);
    for (const comment of await AgentTaskComment.findAll()) {
      check(`comment ${comment.id}.body`, comment.body);
      check(`comment ${comment.id}.authorName`, comment.authorName);
    }
    for (const activity of await AgentActivity.findAll()) {
      check(`activity ${activity.id}.title`, activity.title);
      check(`activity ${activity.id}.body`, activity.body);
    }
    for (const question of await AgentRunInteraction.findAll()) {
      check(`interaction ${question.id}.message`, question.message);
      check(`interaction ${question.id}.requestedSchema`, JSON.stringify(question.requestedSchema));
    }
    for (const approval of await AgentApprovalRequest.findAll()) {
      check(`approval ${approval.id}.title`, approval.title);
      check(`approval ${approval.id}.message`, approval.message);
      check(`approval ${approval.id}.links`, JSON.stringify(approval.links));
    }
    for (const spec of await PipelineSpec.findAll()) check(`pipelineSpec ${spec.id}.name`, spec.name);
    for (const workflow of await AgentWorkflowSpec.findAll()) {
      check(`workflow ${workflow.id}.name`, workflow.name);
      check(`workflow ${workflow.id}.spec`, JSON.stringify(workflow.spec));
    }

    expect(offenders).toEqual([]);
  }, 30_000);

  it('история выглядит историей: время строк — заданное, а не «только что»', async () => {
    const now = new Date('2026-09-17T12:00:00Z');
    await seedDemoWorkspace({ ownerUserId: OWNER, now });

    // Sequelize штампует `updatedAt` текущим временем и при create, и при update — без молчащего
    // досохранения весь демо-проект читается как «изменено минуту назад», а доска задач,
    // отсортированная по этому полю, теряет всякий порядок.
    const task = await AgentTask.findByPk('demo-task-dark-theme');
    expect(now.getTime() - task!.updatedAt.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);

    const run = await AgentRun.findByPk('demo-run-dark-theme');
    expect(now.getTime() - run!.createdAt.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);
  }, 30_000);

  it('повторный вызов обновляет те же строки, а не создаёт вторые', async () => {
    await seedDemoWorkspace({ ownerUserId: OWNER, now: new Date('2026-09-17T12:00:00Z') });
    const before = {
      projects: await AgentProject.count(),
      tasks: await AgentTask.count(),
      runs: await AgentRun.count(),
      stages: await AgentStageExecution.count(),
      logs: await AgentRunLog.count(),
    };

    await seedDemoWorkspace({ ownerUserId: OWNER, now: new Date('2026-09-17T13:00:00Z') });

    expect({
      projects: await AgentProject.count(),
      tasks: await AgentTask.count(),
      runs: await AgentRun.count(),
      stages: await AgentStageExecution.count(),
      logs: await AgentRunLog.count(),
    }).toEqual(before);
  }, 30_000);

  it('не оживает само: ни одна запись очереди не выглядит для подметальщика живой', async () => {
    await seedDemoWorkspace({ ownerUserId: OWNER });
    const jobs = await AgentRunJob.findAll();
    expect(jobs.length).toBeGreaterThan(0);
    // `AgentJobReaperService` подметает leased/running (истёкшая аренда) и released (перезапуск).
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
  }, 30_000);

  it('оба демо-пайплайна — настоящие документы, а не декорация', async () => {
    await seedDemoWorkspace({ ownerUserId: OWNER });
    const specs = await PipelineSpec.findAll();
    expect(specs.length).toBe(2);
    for (const spec of specs) expect(() => assertValidSpec(spec.spec)).not.toThrow();
  }, 30_000);

  it('удаление демо не трогает соседний проект', async () => {
    const foreign = await AgentProject.create({
      name: 'Настоящий', slug: 'real', repoProvider: 'github',
      repoConfig: { owner: 'o', repo: 'r', defaultBranch: 'main' }, trackerConfig: {}, isActive: true, secrets: {},
    } as any);
    const foreignTask = await AgentTask.create({
      projectId: foreign.id, externalId: 'REAL-1', title: 'Своя задача', status: 'new', priority: 'normal',
    } as any);

    await seedDemoWorkspace({ ownerUserId: OWNER });
    const deleted = await removeDemoWorkspaceContent();

    expect(deleted.tasks).toBeGreaterThan(0);
    expect(await AgentTask.findByPk(foreignTask.id)).not.toBeNull();
    expect(await AgentProject.findByPk(foreign.id)).not.toBeNull();
    // Сам демо-проект переживает снос содержимого: его id и членство владельца переиспользуются.
    expect(await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } })).not.toBeNull();
    expect(await AgentTask.count({ where: { projectId: (await AgentProject.findOne({ where: { slug: DEMO_PROJECT_SLUG } }))!.id } })).toBe(0);
  }, 30_000);
});
