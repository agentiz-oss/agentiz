import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { MobileInboxDismissal } from '../models/MobileInboxDismissal';
import { AgentApprovalRequest } from '../../app-agentiz/models/AgentApprovalRequest';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentProjectMember } from '../../app-agentiz/models/AgentProjectMember';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { ROLE_PRESETS } from '../../app-agentiz/lib/access/tokens';
import { ApprovalService } from '../../app-agentiz/services/ApprovalService';
import { MobileApprovalService } from './MobileApprovalService';
import { MobileActivityService } from './MobileActivityService';

/**
 * The far end of the human gate: what a phone sees, and who is allowed to press the buttons.
 *
 * The interesting cases are all about *who*, because the row itself is trivially readable. A
 * decision is addressed by token — «Тестировщики» and every step above them — so a person who can
 * see the project perfectly well but only observe it must not get a card with two buttons that
 * answer 404 when pressed. That is checked from both sides here: the inbox row and the endpoint.
 */
describe('mobile approvals', () => {
  let sequelize: Sequelize;
  let Group: any;
  let project: AgentProject;
  let task: AgentTask;
  let approval: AgentApprovalRequest;

  const OWNER = 1;
  const OBSERVER = 2;
  const TESTER = 3;
  const STRANGER = 4;

  const groupFor = async (key: string) => {
    const preset = ROLE_PRESETS.find((item) => item.key === key)!;
    const row = await Group.create({ name: preset.name, tokens: preset.tokens } as any);
    return Number((row.get({ plain: true }) as any).id);
  };

  beforeEach(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: [...Object.values(agentizModels), MobileInboxDismissal] as any[],
    });
    Group = sequelize.define(
      'GroupAP',
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false },
        tokens: { type: DataTypes.JSON },
      },
      { tableName: 'groupap', timestamps: true },
    );
    await sequelize.sync({ force: true });

    project = await AgentProject.create({ name: 'Alpha', slug: 'alpha', ownerId: OWNER } as any);
    task = await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'Кнопка выхода', status: 'new', priority: 'normal',
    } as any);
    await AgentProjectMember.create({ projectId: project.id, userId: OBSERVER, groupId: await groupFor('observer') } as any);
    await AgentProjectMember.create({ projectId: project.id, userId: TESTER, groupId: await groupFor('tester') } as any);

    approval = (await ApprovalService.request({
      projectId: project.id,
      taskId: task.id,
      workflowRunId: 'flow-1',
      nodeId: 'gate',
      title: 'Примите работу: Кнопка выхода',
      message: 'Посмотрите превью и решите',
      links: [{ label: 'Превью', url: 'https://preview.example/logout' }],
    })).approval;
  });

  it('показывает заявку тому, кто вправе решать, и не показывает наблюдателю', async () => {
    expect((await MobileApprovalService.list(TESTER)).map((row: any) => row.id)).toEqual([approval.id]);
    expect(await MobileApprovalService.list(OBSERVER)).toEqual([]);
    expect(await MobileApprovalService.list(STRANGER)).toEqual([]);
  });

  it('во «Входящих» это блокирующая строка с двумя кнопками, и она считается', async () => {
    const summary = await MobileActivityService.summary(TESTER, TESTER);
    const row = summary.items.find((item) => item.kind === 'approval')!;

    expect(row.id).toBe(`approval:${approval.id}`);
    expect(row.badge).toBe('решение');
    expect(row.headline).toBe('Примите работу: Кнопка выхода');
    expect(row.facts).toContain('ссылка');
    expect(row.actions.map((action) => action.key)).toEqual(['approve', 'reject']);
    // Blocking: it holds a whole workflow, so it is counted and cannot be waved away.
    expect(row.dismissible).toBe(false);
    expect(summary.actionableCount).toBe(1);

    // The observer's inbox does not contain it at all — not a card with the buttons removed.
    const forObserver = await MobileActivityService.summary(OBSERVER, OBSERVER);
    expect(forObserver.items.some((item) => item.kind === 'approval')).toBe(false);
    expect(forObserver.actionableCount).toBe(0);
  });

  it('чужая заявка отвечает 404, а не 403 — как всё остальное в этом API', async () => {
    await expect(MobileApprovalService.byId(approval.id, OBSERVER)).rejects.toMatchObject({ status: 404 });
    await expect(MobileApprovalService.decide(approval.id, STRANGER, 'approved')).rejects.toMatchObject({ status: 404 });
    expect((await AgentApprovalRequest.findByPk(approval.id))!.status).toBe('pending');
  });

  it('отказ без причины отвергается: этот текст получает агент', async () => {
    await expect(MobileApprovalService.decide(approval.id, TESTER, 'rejected', '   '))
      .rejects.toMatchObject({ status: 400 });
    expect((await AgentApprovalRequest.findByPk(approval.id))!.status).toBe('pending');
  });

  it('решение записывается на человека и второй раз не принимается', async () => {
    const decided: any = await MobileApprovalService.decide(approval.id, TESTER, 'rejected', 'кнопка не там');
    expect(decided.status).toBe('rejected');
    expect(decided.decidedByUserId).toBe(TESTER);
    expect(decided.decisionComment).toBe('кнопка не там');

    await expect(MobileApprovalService.decide(approval.id, TESTER, 'approved'))
      .rejects.toMatchObject({ status: 409 });

    // And it leaves the inbox by itself: the list is computed from live rows, never from the feed.
    expect(await MobileApprovalService.list(TESTER)).toEqual([]);
    expect((await MobileActivityService.summary(TESTER, TESTER)).actionableCount).toBe(0);
  });

  it('заявка, адресованная одному человеку, не будит остальных, кто вправе', async () => {
    await AgentApprovalRequest.update({ assigneeUserId: OWNER }, { where: { id: approval.id } });

    const forTester = await MobileActivityService.summary(TESTER, TESTER);
    expect(forTester.items.some((item) => item.kind === 'approval')).toBe(false);
    const forOwner = await MobileActivityService.summary(OWNER, OWNER);
    expect(forOwner.items.some((item) => item.kind === 'approval')).toBe(true);
  });
});
