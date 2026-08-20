/**
 * Storage for task attachments: where the bytes live and every way they are touched.
 *
 * The database row (AgentTaskAttachment) is metadata; the content sits on disk under
 * `attachmentsRoot()` — `data/task-attachments` by default, which is the directory the production
 * compose file already mounts as a volume, so files survive a redeploy the same way the database
 * does. `AGENTIZ_ATTACHMENTS_DIR` overrides the root for deployments that keep bulk storage
 * elsewhere.
 *
 * Every path on disk is `<taskId>/<attachmentId><ext>`, assembled from server-generated UUIDs.
 * The uploaded filename is display metadata only — it goes into the row, never into the path, so
 * `../../etc/cron.d/x` uploads as an oddly named but harmless file. The extension is kept (letters
 * and digits only) purely so a human poking around the volume sees `…a1b2.png`, not a bare UUID.
 */
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { AgentTaskAttachment } from '../models/AgentTaskAttachment';

/** Per-file ceiling. The Worker API accepts 25mb patches, so the transport already fits this. */
export const MAX_ATTACHMENT_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.AGENTIZ_ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024,
);

/** Attachments per task. A guard against a stuck upload loop, not a product decision. */
export const MAX_ATTACHMENTS_PER_TASK = 100;

export class AttachmentError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function attachmentsRoot(): string {
  return process.env.AGENTIZ_ATTACHMENTS_DIR
    ? path.resolve(process.env.AGENTIZ_ATTACHMENTS_DIR)
    : path.resolve(process.cwd(), 'data', 'task-attachments');
}

/**
 * The uploaded name reduced to a safe basename for display: path separators and control
 * characters out, length capped, empty replaced. This is what the UI shows and what the worker
 * names the local copy after — both treat it as untrusted anyway.
 */
export function sanitizeFileName(raw: unknown): string {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return 'file';
  return base.length > 200 ? base.slice(-200) : base;
}

/** Extension for the on-disk name: taken from the sanitized name, letters/digits only. */
function safeExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/**
 * Absolute path of one attachment's bytes, refusing anything that escapes the root.
 *
 * `storagePath` is server-generated, so an escape can only mean a corrupted row — but this is the
 * single place every read resolves through, and the guard costs one string comparison.
 */
export function attachmentDiskPath(attachment: Pick<AgentTaskAttachment, 'storagePath'>): string {
  const root = attachmentsRoot();
  const resolved = path.resolve(root, attachment.storagePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AttachmentError(500, 'Attachment storage path escapes the attachments root');
  }
  return resolved;
}

/**
 * Reads a request body into a buffer with the size cap enforced *while* reading — a
 * Content-Length header is a promise, not a fact, and the cap must hold against a stream that
 * lies about itself.
 */
export function readBodyWithLimit(stream: Readable, limit: number = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        stream.removeAllListeners('data');
        reject(new AttachmentError(413, `File is larger than the ${Math.floor(limit / 1024 / 1024)}MB limit`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (error) => reject(error));
  });
}

/**
 * Writes the bytes and creates the row, in that order: a row pointing at a missing file is a
 * broken download, a file with no row is only lost disk space. The write itself is temp + rename
 * so a crash mid-write never leaves a half file at the final path.
 */
export async function storeAttachment(input: {
  taskId: string;
  fileName: unknown;
  mimeType: string | null;
  content: Buffer;
  uploadedById?: number | null;
  uploadedByName?: string | null;
}): Promise<AgentTaskAttachment> {
  if (!input.content.length) throw new AttachmentError(400, 'File is empty');
  if (input.content.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, `File is larger than the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit`);
  }
  const existing = await AgentTaskAttachment.count({ where: { taskId: input.taskId } });
  if (existing >= MAX_ATTACHMENTS_PER_TASK) {
    throw new AttachmentError(400, `Task already has ${MAX_ATTACHMENTS_PER_TASK} attachments`);
  }

  const id = randomUUID();
  const fileName = sanitizeFileName(input.fileName);
  const storagePath = path.join(input.taskId, `${id}${safeExtension(fileName)}`);
  const finalPath = attachmentDiskPath({ storagePath });
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp`;
  await fs.promises.writeFile(tempPath, input.content);
  await fs.promises.rename(tempPath, finalPath);

  try {
    return await AgentTaskAttachment.create({
      id,
      taskId: input.taskId,
      fileName,
      mimeType: input.mimeType,
      sizeBytes: input.content.length,
      sha256: createHash('sha256').update(input.content).digest('hex'),
      storagePath,
      uploadedById: input.uploadedById ?? null,
      uploadedByName: input.uploadedByName ?? null,
    });
  } catch (error) {
    // The row failed, so the file is an orphan — remove it rather than leak it.
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Row first, then the file: a download racing the delete 404s cleanly instead of half-reading. */
export async function deleteAttachment(attachment: AgentTaskAttachment): Promise<void> {
  const diskPath = attachmentDiskPath(attachment);
  await attachment.destroy();
  await fs.promises.rm(diskPath, { force: true }).catch(() => {});
}

/** The wire shape of one attachment — what the UI lists and what the job snapshot carries. */
export function describeAttachment(attachment: AgentTaskAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    uploadedByName: attachment.uploadedByName,
    createdAt: attachment.createdAt,
  };
}

export async function listTaskAttachments(taskId: string): Promise<AgentTaskAttachment[]> {
  return AgentTaskAttachment.findAll({ where: { taskId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
}
