import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { DataTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { listActivityNotifiers, registerActivityNotifier, unregisterActivityNotifier } from './activityNotifiers';
import type { ActivityEvent } from './activityNotifiers';
import { ActivityService } from '../services/ActivityService';
import { announceServerVersion, currentServerVersion } from './serverVersion';

const ADMIN = 1;
const RETIRED_ADMIN = 2;
const MEMBER = 3;

/** Fan-out is fire-and-forget; give the queued microtasks a chance to run before asserting. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

const build = (gitSha: string) => ({ gitSha, buildTime: '2026-10-04T10:00:00Z', packageVersion: '1.0.0' });

describe('server version announcement', () => {
  let sequelize: Sequelize;
  const pushCalls: ActivityEvent[] = [];
  const dashboardCalls: ActivityEvent[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    sequelize.define('UserAP', {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      login: { type: DataTypes.STRING },
      isAdministrator: { type: DataTypes.BOOLEAN },
      isDeleted: { type: DataTypes.BOOLEAN },
    }, { tableName: 'userap', timestamps: true });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    pushCalls.length = 0;
    dashboardCalls.length = 0;
    delete process.env.AGENTIZ_NOTIFY_POLICY;
    registerActivityNotifier({ id: 'test:push', channel: 'push', notify: (event) => { pushCalls.push(event); } });
    registerActivityNotifier({ id: 'test:dashboard', channel: 'dashboard', notify: (event) => { dashboardCalls.push(event); } });

    const User: any = sequelize.model('UserAP');
    await User.create({ id: ADMIN, login: 'admin', isAdministrator: true, isDeleted: false });
    await User.create({ id: RETIRED_ADMIN, login: 'gone', isAdministrator: true, isDeleted: true });
    await User.create({ id: MEMBER, login: 'member', isAdministrator: false, isDeleted: false });
    // A project with its own people, so "only administrators" is tested against somebody who
    // would have been addressed by a project event.
    await AgentProject.create({ name: 'Busy', slug: 'busy', ownerId: MEMBER } as any);
  });

  afterEach(() => {
    for (const notifier of listActivityNotifiers()) unregisterActivityNotifier(notifier.id);
    delete process.env.AGENTIZ_NOTIFY_POLICY;
  });

  it('knows no version without GIT_SHA, and treats the Dockerfile default as none', () => {
    expect(currentServerVersion({})).toBeNull();
    expect(currentServerVersion({ GIT_SHA: 'unknown', BUILD_TIME: 'unknown' })).toBeNull();
    expect(currentServerVersion({ GIT_SHA: 'abc1234567', BUILD_TIME: 'unknown' }))
      .toMatchObject({ gitSha: 'abc1234567', buildTime: null });
  });

  it('says nothing and writes nothing when the build is unknown', async () => {
    expect(await announceServerVersion(null)).toEqual({ outcome: 'unknown' });
    await settled();
    expect(await AgentActivity.count()).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });

  it('announces a new build to live administrators only, without a project', async () => {
    const result = await announceServerVersion(build('aaaaaaaa1111'));
    expect(result).toEqual({ outcome: 'announced', gitSha: 'aaaaaaaa1111', previousGitSha: null });

    const rows = await AgentActivity.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'server.updated', kind: 'info', projectId: null, runId: null, taskId: null });
    expect(rows[0].title).toBe('Сервер обновился');
    expect(rows[0].body).toBe('Новая версия: aaaaaaaa');

    await settled();
    expect(pushCalls).toHaveLength(1);
    expect(dashboardCalls).toHaveLength(1);
    expect(pushCalls[0].context.recipientIds).toEqual([ADMIN]);
    expect(pushCalls[0].context.projectName).toBe('');
    expect(pushCalls[0].delivery).toEqual({ push: 'on', dashboard: 'on' });
  });

  it('stays silent on a restart of the same build and speaks again for the next one', async () => {
    await announceServerVersion(build('aaaaaaaa1111'));
    expect(await announceServerVersion(build('aaaaaaaa1111'))).toEqual({ outcome: 'unchanged', gitSha: 'aaaaaaaa1111' });
    expect(await AgentActivity.count()).toBe(1);

    const next = await announceServerVersion(build('bbbbbbbb2222'));
    expect(next).toEqual({ outcome: 'announced', gitSha: 'bbbbbbbb2222', previousGitSha: 'aaaaaaaa1111' });
    // Looked up by sha, not by date: both rows can share a millisecond here, and their ids are random.
    const latest = (await AgentActivity.findAll()).find((row) => row.data?.gitSha === 'bbbbbbbb2222');
    // Only the new version in the text; the previous one stays in `data`.
    expect(latest?.body).toBe('Новая версия: bbbbbbbb');
    expect(latest?.data).toMatchObject({ gitSha: 'bbbbbbbb2222', previousGitSha: 'aaaaaaaa1111' });
  });

  it('honours the policy defaults, the only scope a project-less event resolves through', async () => {
    process.env.AGENTIZ_NOTIFY_POLICY = JSON.stringify({ defaults: { 'server.updated': { push: 'off' } } });

    await announceServerVersion(build('aaaaaaaa1111'));
    await settled();

    expect(await AgentActivity.count()).toBe(1);
    expect(pushCalls).toHaveLength(0);
    expect(dashboardCalls).toHaveLength(1);
  });

  it('keeps the two doors apart: no project event without a project, no installation event inside one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await AgentProject.findOne();

    expect(await ActivityService.record({ type: 'server.updated', projectId: project!.id, title: 't', body: 'b' })).toBeNull();
    expect(await ActivityService.recordInstallation({ type: 'run.failed', title: 't', body: 'b' })).toBeNull();
    expect(await AgentActivity.count()).toBe(0);
    warn.mockRestore();
  });
});
