import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { GatewayError } from './upstream.js';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const MAGIC = Buffer.from('SABACK01');
const compress = promisify(gzip), decompress = promisify(gunzip);
export const invalidBackup = () => new GatewayError('备份密码不正确，或文件损坏、格式不受支持。', 'invalid_backup', 400);
export function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new GatewayError('备份密码需为 12–256 个字符。', 'invalid_backup_password', 400);
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function sealBackup(payload: string, password: string): Promise<Buffer> {
  checkPassword(password);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new GatewayError('数据超过网页备份的 256 MiB 限制，请停机后整体备份数据目录。', 'backup_too_large', 413);
  const header = Buffer.concat([MAGIC, randomBytes(16), randomBytes(12)]);
  const key = await derive(password, header.subarray(8, 24));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24));
    cipher.setAAD(header);
    const packed = await compress(payload);
    if (packed.length + 52 > MAX_ARCHIVE_BYTES) throw new GatewayError('备份超过 64 MiB 文件限制，请停机后整体备份数据目录。', 'backup_too_large', 413);
    return Buffer.concat([header, cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}
export async function openBackup(archive: Buffer, password: string): Promise<unknown> {
  checkPassword(password);
  if (archive.length < 53 || archive.length > MAX_ARCHIVE_BYTES || !archive.subarray(0, 8).equals(MAGIC)) throw invalidBackup();
  const key = await derive(password, archive.subarray(8, 24));
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, archive.subarray(24, 36));
    cipher.setAAD(archive.subarray(0, 36)); cipher.setAuthTag(archive.subarray(-16));
    const packed = Buffer.concat([cipher.update(archive.subarray(36, -16)), cipher.final()]);
    const plain = await decompress(packed, { maxOutputLength: MAX_PAYLOAD_BYTES });
    try { return JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); packed.fill(0); }
  } catch { throw invalidBackup(); }
  finally { key.fill(0); }
}
