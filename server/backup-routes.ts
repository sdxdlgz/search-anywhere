import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { Backups } from './backups.js';
import { checkPassword, MAX_ARCHIVE_BYTES } from './backup-crypto.js';
import { GatewayError } from './upstream.js';

const metadata = z.object({ password: z.string().min(12).max(256), confirmation_token: z.string().length(64).optional() }).strict();
const raw = express.raw({ type: 'application/octet-stream', limit: MAX_ARCHIVE_BYTES + 2052, inflate: false });
async function upload(req: Request, res: Response) {
  if (!req.is('application/octet-stream')) throw new GatewayError('请上传加密备份文件。', 'invalid_backup_upload', 415);
  await new Promise<void>((resolve, reject) => raw(req, res, error => error ? reject(error) : resolve()));
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 5) throw new GatewayError('备份上传内容不完整。', 'invalid_backup_upload', 400);
  const length = body.readUInt32BE(0);
  if (length < 2 || length > 2048 || body.length < 4 + length) throw new GatewayError('备份上传内容无效。', 'invalid_backup_upload', 400);
  const input = metadata.parse(JSON.parse(body.subarray(4, 4 + length).toString('utf8')));
  return { ...input, archive: body.subarray(4 + length) };
}
export function backupRoutes(backups: Backups) {
  const router = express.Router();
  router.post('/export', async (req, res) => {
    const { password } = z.object({ password: z.string() }).strict().parse(req.body);
    checkPassword(password);
    await backups.exclusive(async () => {
      const archive = await backups.export(password);
      res.attachment(`search-anywhere-${new Date().toISOString().slice(0, 10)}.sab`).type('application/octet-stream').send(archive);
    });
  });
  for (const action of ['preview', 'restore'] as const) router.post(`/${action}`, async (req, res) => {
    await backups.exclusive(async () => {
      const { password, archive, confirmation_token } = await upload(req, res);
      const result = action === 'preview' ? await backups.preview(archive, password) : await backups.restore(archive, password, confirmation_token || '');
      res.json(result);
    });
  });
  router.use((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'status' in error && error.status === 413) return next(new GatewayError('备份文件超过 64 MiB，请停机后整体复制数据目录。', 'backup_too_large', 413));
    next(error);
  });
  return router;
}
