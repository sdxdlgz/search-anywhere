import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Engine } from './engine.js';
import type { ParallelAuth } from './parallel-auth.js';
import { safeEqual } from './security.js';
import { openBackup, sealBackup } from './backup-crypto.js';
import { backupSummary, captureBackup, restoreBackup, validateBackup } from './backup-data.js';
import { GatewayError } from './upstream.js';

export class Backups {
  private epoch = randomUUID();
  constructor(private store: Store, private engine: Engine, private auth: ParallelAuth) {}
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.store.maintenance || this.engine.busy || this.auth.busy) throw new GatewayError('有搜索、余额查询、授权或备份正在进行，请完成后重试。', 'backup_busy', 409);
    this.store.maintenance = true;
    try { return await task(); } finally { this.store.maintenance = false; }
  }
  private confirmation(archive: Buffer): string {
    const changes = this.store.get<{ n: number }>('SELECT total_changes() n')!.n;
    return createHash('sha256').update(this.epoch).update(String(changes)).update(archive).digest('hex');
  }
  export(password: string) { return sealBackup(JSON.stringify(captureBackup(this.store)), password); }
  async preview(archive: Buffer, password: string) {
    const data = validateBackup(this.store, await openBackup(archive, password));
    return { summary: backupSummary(data), confirmation_token: this.confirmation(archive) };
  }
  async restore(archive: Buffer, password: string, confirmation: string) {
    if (!confirmation || !safeEqual(confirmation, this.confirmation(archive))) throw new GatewayError('文件或当前数据已变化，请重新预览后再恢复。', 'backup_changed', 409);
    const data = validateBackup(this.store, await openBackup(archive, password));
    if (!safeEqual(confirmation, this.confirmation(archive))) throw new GatewayError('当前数据已变化，请重新预览后再恢复。', 'backup_changed', 409);
    restoreBackup(this.store, data);
    this.engine.resetRuntime(); this.auth.reset(); this.epoch = randomUUID();
    return { summary: backupSummary(data) };
  }
}
