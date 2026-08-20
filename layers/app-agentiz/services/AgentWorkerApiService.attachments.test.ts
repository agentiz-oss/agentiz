import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
  AbstractNotificationService: class {
    protected adminizer: any;
    constructor(adminizer: any) {
      this.adminizer = adminizer;
    }
  },
}));
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentTask } from '../models/AgentTask';
import { AgentWorker } from '../models/AgentWorker';
import { storeAttachment } from '../lib/taskAttachments';
import { AgentWorkerApiService, WorkerApiError } from './AgentWorkerApiService';

/**
 * The leased attachments endpoint: the same lease gate as secrets, plus "this file belongs to
 * this job's task". The 404 for a foreign attachment is load-bearing — the worker treats it as
 * "skip with a warning", so it must not leak whether the id exists at all.
 */
describe('AgentWorkerApiService.issueAttachment', () => {
  let sequelize: Sequelize;
  let root: string;
  let job: AgentRunJob;
  let attachmentId: string;
  let foreignAttachmentId: string;

  const TOKEN = 'agw_test_token';
  const LEASE = 'lease-token';
  const auth = `Bearer ${TOKEN}`;
  const leaseBody = { schemaVersion: 1, attempt: 1, leaseToken: LEASE };

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    await sequelize.sync({ force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentiz-attachments-api-'));
    process.env.AGENTIZ_ATTACHMENTS_DIR = root;

    const project = await AgentProject.create({ name: 'P', slug: 'p', ownerId: 1 } as any);
    const task = await AgentTask.create({ projectId: project.id, externalId: 'local:1', title: 'T', status: 'running', priority: 'normal' } as any);
    const otherTask = await AgentTask.create({ projectId: project.id, externalId: 'local:2', title: 'Other', status: 'new', priority: 'normal' } as any);
    const run = await AgentRun.create({
      projectId: project.id, taskId: task.id, status: 'running', trigger: 'manual', currentStageIndex: 0,
      pipelineSnapshot: { stages: [], finalAction: { type: 'none' } },
    } as any);
    const worker = await AgentWorker.create({
      name: 'w1', status: 'active',
      tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    } as any);
    job = await AgentRunJob.create({
      runId: run.id, projectId: project.id, jobKind: 'pipeline', status: 'running', priority: 100,
      attempt: 1, workerId: worker.id,
      leaseTokenHash: createHash('sha256').update(LEASE).digest('hex'),
      lockedUntil: new Date(Date.now() + 60_000),
      snapshot: {},
    } as any);
    attachmentId = (await storeAttachment({
      taskId: task.id, fileName: 'фото.png', mimeType: 'image/png', content: Buffer.from('png-bytes'),
    })).id;
    foreignAttachmentId = (await storeAttachment({
      taskId: otherTask.id, fileName: 'other.txt', mimeType: 'text/plain', content: Buffer.from('x'),
    })).id;
  });

  afterAll(async () => {
    delete process.env.AGENTIZ_ATTACHMENTS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
    await sequelize.close();
  });

  it('hands out a file of the job task under a valid lease', async () => {
    const file = await AgentWorkerApiService.issueAttachment(job.id, attachmentId, leaseBody, auth);
    expect(file.fileName).toBe('фото.png');
    expect(file.mimeType).toBe('image/png');
    expect(fs.readFileSync(file.diskPath, 'utf8')).toBe('png-bytes');
  });

  it('answers 404 for another task attachment', async () => {
    await expect(AgentWorkerApiService.issueAttachment(job.id, foreignAttachmentId, leaseBody, auth))
      .rejects.toMatchObject({ status: 404 });
  });

  it('refuses a wrong lease before touching the file', async () => {
    await expect(
      AgentWorkerApiService.issueAttachment(job.id, attachmentId, { ...leaseBody, leaseToken: 'stolen' }, auth),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      AgentWorkerApiService.issueAttachment(job.id, attachmentId, leaseBody, 'Bearer wrong'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('is a WorkerApiError, so the router turns it into a status', async () => {
    await expect(AgentWorkerApiService.issueAttachment(job.id, foreignAttachmentId, leaseBody, auth))
      .rejects.toBeInstanceOf(WorkerApiError);
  });
});
