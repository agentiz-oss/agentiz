import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskAttachment } from '../models/AgentTaskAttachment';
import {
  AttachmentError,
  attachmentDiskPath,
  deleteAttachment,
  sanitizeFileName,
  storeAttachment,
} from './taskAttachments';

describe('taskAttachments storage', () => {
  let sequelize: Sequelize;
  let root: string;

  beforeAll(async () => {
    // The whole model graph: the attachment model carries associations into AgentTask, and
    // sequelize-typescript refuses a partial registration.
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentiz-attachments-'));
    process.env.AGENTIZ_ATTACHMENTS_DIR = root;
  });

  afterAll(async () => {
    delete process.env.AGENTIZ_ATTACHMENTS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
    await sequelize.close();
  });

  let taskId = '';

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    const project = await AgentProject.create({ name: 'P', slug: 'p', ownerId: 1 } as any);
    taskId = (await AgentTask.create({
      projectId: project.id, externalId: 'local:1', title: 'T', status: 'new', priority: 'normal',
    } as any)).id;
  });

  it('keeps a plain name and strips a path-shaped one to its basename', () => {
    expect(sanitizeFileName('screenshot.png')).toBe('screenshot.png');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\доклад.pdf')).toBe('доклад.pdf');
    expect(sanitizeFileName('..')).toBe('file');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('a\u0000b\u001f.txt')).toBe('ab.txt');
  });

  it('stores bytes under ids, never under the uploaded name', async () => {
    const attachment = await storeAttachment({
      taskId,
      fileName: '../../evil.sh',
      mimeType: 'text/x-sh',
      content: Buffer.from('echo hi'),
    });
    expect(attachment.fileName).toBe('evil.sh');
    expect(attachment.storagePath.startsWith(taskId + path.sep)).toBe(true);
    expect(attachment.storagePath).not.toContain('..');
    const diskPath = attachmentDiskPath(attachment);
    expect(diskPath.startsWith(root + path.sep)).toBe(true);
    expect(fs.readFileSync(diskPath, 'utf8')).toBe('echo hi');
    expect(attachment.sha256).toHaveLength(64);
    expect(attachment.sizeBytes).toBe(7);
  });

  it('refuses an empty file and one over the limit', async () => {
    await expect(storeAttachment({ taskId: 't', fileName: 'a', mimeType: null, content: Buffer.alloc(0) }))
      .rejects.toBeInstanceOf(AttachmentError);
  });

  it('refuses a storage path that escapes the root', () => {
    expect(() => attachmentDiskPath({ storagePath: '../outside.txt' })).toThrow(AttachmentError);
  });

  it('deletes the row and the bytes together', async () => {
    const attachment = await storeAttachment({
      taskId,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      content: Buffer.from('x'),
    });
    const diskPath = attachmentDiskPath(attachment);
    expect(fs.existsSync(diskPath)).toBe(true);
    await deleteAttachment(attachment);
    expect(fs.existsSync(diskPath)).toBe(false);
    expect(await AgentTaskAttachment.findByPk(attachment.id)).toBeNull();
  });
});
