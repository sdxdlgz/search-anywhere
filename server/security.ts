import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function mask(value: string): string {
  const edge = value.length >= 16 ? 4 : 2;
  return `${value.slice(0, edge)}••••••••${value.slice(-edge)}`;
}
export class Vault {
  private key: Buffer;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'encryption.key');
    if (!existsSync(path) && existsSync(join(directory, 'gateway.sqlite'))) {
      throw new Error('加密密钥缺失：请恢复 .data/encryption.key，不能为现有数据库创建新密钥。');
    }
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error('加密密钥长度无效。');
  }
  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
  }
  decrypt(value: string): string {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
}
export function adminCredential(directory: string): string {
  if (process.env.SA_ADMIN_TOKEN) {
    if (process.env.SA_ADMIN_TOKEN.length < 16) throw new Error('SA_ADMIN_TOKEN 至少需要 16 个字符。');
    return process.env.SA_ADMIN_TOKEN;
  }
  const path = join(directory, 'admin-token.txt');
  if (!existsSync(path)) writeFileSync(path, newToken('sa_admin'), { mode: 0o600, flag: 'wx' });
  return readFileSync(path, 'utf8').trim();
}
