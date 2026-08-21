import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../../app-agentiz/models';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentTaskComment } from '../../app-agentiz/models/AgentTaskComment';
import { MobileTaskService } from './MobileTaskService';

const OWNER = 31;
const STRANGER = 32;

/**
 * Attachments over the mobile API. The app writes through the same storage helper the panel uses,
 * so what matters here is the part that is this layer's own: scope. Every call resolves the file
 * through the task and the task through its project's owner, and a foreign one has to read as 404
 * — a 403 would confirm the id exists to someone who should not know that.
 */
describe('MobileTaskService attachments', () => {
  let sequelize: Sequelize;
  let root: string;
  let taskId: string;
  let strangerTaskId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentiz-mobile-attachments-'));
    process.env.AGENTIZ_ATTACHMENTS_DIR = root;
  });

  afterAll(async () => {
    delete process.env.AGENTIZ_ATTACHMENTS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
    await sequelize.close();
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const mine = await AgentProject.create({ name: 'Owned', slug: 'owned', ownerId: OWNER } as any);
    const theirs = await AgentProject.create({ name: 'Theirs', slug: 'theirs', ownerId: STRANGER } as any);
    taskId = (await AgentTask.create({ projectId: mine.id, externalId: 'local:1', title: 'Кнопка синей', status: 'new', priority: 'normal' } as any)).id;
    strangerTaskId = (await AgentTask.create({ projectId: theirs.id, externalId: 'local:2', title: 'Чужая', status: 'new', priority: 'normal' } as any)).id;
  });

  const actor = { id: OWNER, name: 'mobile-user' };
  const upload = (name = 'photo.jpg', bytes = Buffer.from('jpeg-bytes')) =>
    MobileTaskService.addAttachment(taskId, OWNER, { fileName: name, mimeType: 'image/jpeg', content: bytes }, actor);

  it('stores an uploaded photo and reports it back to the app', async () => {
    const created = await upload();

    expect(created).toMatchObject({ fileName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 10 });
    // No sha256 on the wire: the app has nothing to verify it against, and the row keeps it.
    expect(created).not.toHaveProperty('sha256');
    expect(await MobileTaskService.listAttachments(taskId, OWNER)).toHaveLength(1);
  });

  it('leaves the upload in the task thread, so a later run sees it in the conversation', async () => {
    await upload('screen.png');

    const comments = await AgentTaskComment.findAll({ where: { taskId } });
    const note = comments.find((comment) => (comment.meta as any)?.kind === 'attachment.added');
    expect(note?.body).toContain('screen.png');
    expect((note?.meta as any)?.via).toBe('mobile');
  });

  it('carries attachments in the task detail the app opens', async () => {
    await upload();

    const detail = await MobileTaskService.detail(taskId, OWNER) as any;
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0].fileName).toBe('photo.jpg');
  });

  it('hands back the bytes it stored', async () => {
    const created = await upload('note.txt', Buffer.from('hello'));

    const file = await MobileTaskService.attachmentFile(taskId, created.id, OWNER);
    expect(fs.readFileSync(file.diskPath, 'utf8')).toBe('hello');
    expect(file.fileName).toBe('note.txt');
  });

  it('refuses every operation on someone else task as a 404', async () => {
    const created = await upload();

    await expect(MobileTaskService.listAttachments(taskId, STRANGER)).rejects.toMatchObject({ status: 404 });
    await expect(MobileTaskService.attachmentFile(taskId, created.id, STRANGER)).rejects.toMatchObject({ status: 404 });
    await expect(MobileTaskService.removeAttachment(taskId, created.id, STRANGER, actor)).rejects.toMatchObject({ status: 404 });
    await expect(
      MobileTaskService.addAttachment(strangerTaskId, OWNER, { fileName: 'x.txt', mimeType: null, content: Buffer.from('x') }, actor),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('will not read an attachment through a task it does not belong to', async () => {
    const created = await upload();
    // The caller owns both ids here — the pairing is what is wrong, and that alone must fail.
    const otherOwnTask = await AgentTask.create({
      projectId: (await AgentProject.findOne({ where: { ownerId: OWNER } }))!.id,
      externalId: 'local:3', title: 'Другая', status: 'new', priority: 'normal',
    } as any);

    await expect(MobileTaskService.attachmentFile(otherOwnTask.id, created.id, OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes the row and the bytes, and says so in the thread', async () => {
    const created = await upload();
    const file = await MobileTaskService.attachmentFile(taskId, created.id, OWNER);

    expect(await MobileTaskService.removeAttachment(taskId, created.id, OWNER, actor)).toEqual({ deleted: true });
    expect(fs.existsSync(file.diskPath)).toBe(false);
    expect(await MobileTaskService.listAttachments(taskId, OWNER)).toHaveLength(0);
    const comments = await AgentTaskComment.findAll({ where: { taskId } });
    expect(comments.some((comment) => (comment.meta as any)?.kind === 'attachment.deleted')).toBe(true);
  });
});
