import { createHmac, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Engine } from './engine.js';
import type { ParallelAuth } from './parallel-auth.js';
import type { CleanupCounts, CleanupPreview, CleanupResult, RetentionStatus } from '../shared/types.js';
import { GatewayError } from './upstream.js';
import { safeEqual } from './security.js';

const DAY = 86400000;
const requestFields = ['query', 'caller', 'profile'];
const callFields = ['key_label', 'account', 'masked', 'mode', 'operation', 'http_status', 'error_code', 'usage_json', 'warnings_json', 'fallback_reason'];
const bytes = (fields: string[]) => fields.map(field => `COALESCE(length(CAST(${field} AS BLOB)),0)`).join('+');
// Every gateway call starts with a label; NULL marks compacted accounting rows.
const hasDetails = 'key_label IS NOT NULL';
const finishedRequest = "NOT EXISTS (SELECT 1 FROM calls c WHERE c.request_id=requests.id AND c.status='running')";
const finishedCollection = "NOT EXISTS (SELECT 1 FROM requests r WHERE r.id=collections.id AND r.status='running') AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.request_id=collections.id AND c.status='running')";
const finishedCall = "NOT EXISTS (SELECT 1 FROM requests r WHERE r.id=calls.request_id AND r.status='running')";

export class Retention {
  private epoch = randomUUID();
  private lastError: string | null = null;
  constructor(private store: Store, private engine: Engine, private auth: Pick<ParallelAuth, 'busy'>, private clock = Date.now) {}
  private busy() {
    return this.store.maintenance || this.engine.busy || this.auth.busy || !!this.store.get("SELECT 1 FROM requests WHERE status='running' UNION ALL SELECT 1 FROM calls WHERE status='running' LIMIT 1");
  }
  private available() {
    if (this.busy()) throw new GatewayError('有搜索、余额查询、授权或备份正在进行，请完成后再清理。', 'cleanup_busy', 409);
  }
  private counts(cutoff: string): CleanupCounts {
    const request = this.store.get<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(${bytes(requestFields)}),0) bytes FROM requests WHERE created_at<? AND query IS NOT NULL AND status!='running' AND ${finishedRequest}`, cutoff)!;
    const collection = this.store.get<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(length(CAST(value AS BLOB))),0) bytes FROM collections WHERE created_at<? AND ${finishedCollection}`, cutoff)!;
    const call = this.store.get<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(${bytes(callFields)}),0) bytes FROM calls WHERE created_at<? AND status!='running' AND (${hasDetails}) AND ${finishedCall}`, cutoff)!;
    return { requests: request.count, collections: collection.count, call_details: call.count, content_bytes: request.bytes + collection.bytes + call.bytes };
  }
  status(): RetentionStatus {
    const settings = this.store.settings(), policy = settings.history_retention!;
    const pageSize = this.store.get<{ page_size: number }>('PRAGMA page_size')!.page_size;
    const freePages = this.store.get<{ freelist_count: number }>('PRAGMA freelist_count')!.freelist_count;
    const size = (file: string) => { try { return statSync(join(this.store.directory, file)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; } };
    return { policy, last_cleanup: settings.history_cleanup ?? null, last_error: this.lastError,
      next_cleanup_at: policy.enabled ? new Date(settings.history_cleanup ? Date.parse(settings.history_cleanup.completed_at) + DAY : this.clock()).toISOString() : null,
      retained: this.counts('9999-12-31T23:59:59.999Z'),
      storage: { database_bytes: size('gateway.sqlite'), wal_bytes: size('gateway.sqlite-wal'), reusable_bytes: freePages * pageSize } };
  }
  private token(cutoff: string, expires: string, counts: CleanupCounts) {
    const changes = this.store.get<{ n: number }>('SELECT total_changes() n')!.n;
    return createHmac('sha256', this.epoch).update(JSON.stringify([cutoff, expires, counts, changes])).digest('hex');
  }
  preview(days: number): CleanupPreview {
    this.available();
    const cutoff = new Date(this.clock() - days * DAY).toISOString(), expires_at = new Date(this.clock() + 600000).toISOString();
    const counts = this.counts(cutoff);
    return { ...counts, cutoff, expires_at, confirmation_token: this.token(cutoff, expires_at, counts) };
  }
  confirm(input: Pick<CleanupPreview, 'cutoff' | 'expires_at' | 'confirmation_token'>): CleanupResult {
    this.available();
    const counts = this.counts(input.cutoff);
    if (Date.parse(input.expires_at) <= this.clock() || !safeEqual(input.confirmation_token, this.token(input.cutoff, input.expires_at, counts))) {
      throw new GatewayError('预览已过期或数据已变化，请重新预览后再清理。', 'cleanup_changed', 409);
    }
    return this.clean(input.cutoff, 'manual', counts);
  }
  tick() {
    try {
      const settings = this.store.settings(), policy = settings.history_retention!;
      if (!policy.enabled || this.busy()) return;
      const last = settings.history_cleanup ? Date.parse(settings.history_cleanup.completed_at) : 0;
      if (last <= this.clock() && this.clock() - last < DAY) return;
      const cutoff = new Date(this.clock() - policy.days * DAY).toISOString();
      this.clean(cutoff, 'automatic', this.counts(cutoff));
    }
    catch { this.lastError = '自动清理未完成，数据已回滚；将在下一次空闲检查时重试。'; }
  }
  private clean(cutoff: string, source: CleanupResult['source'], counts: CleanupCounts): CleanupResult {
    this.store.maintenance = true;
    try {
      const result = { ...counts, cutoff, source, completed_at: new Date(this.clock()).toISOString() };
      this.store.transaction(() => {
        this.store.run(`DELETE FROM collections WHERE created_at<? AND ${finishedCollection}`, cutoff);
        this.store.run(`UPDATE requests SET query=NULL,caller=NULL,profile=NULL WHERE created_at<? AND query IS NOT NULL AND status!='running' AND ${finishedRequest}`, cutoff);
        // Accounting fields and implicit rowids must survive: Exa calibrations use a call-row cursor.
        this.store.run(`UPDATE calls SET ${callFields.map(field => `${field}=NULL`).join(',')} WHERE created_at<? AND status!='running' AND (${hasDetails}) AND ${finishedCall}`, cutoff);
        this.store.run('DELETE FROM sessions WHERE expires<=?', this.clock());
        this.store.run('UPDATE settings SET value=? WHERE id=1', JSON.stringify({ ...this.store.settings(), history_cleanup: result }));
      });
      this.engine.clearSearchCache(); this.epoch = randomUUID(); this.lastError = null;
      // Reuse freed pages; VACUUM can renumber implicit rowids and invalidate billing cursors.
      try { this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* A reader can postpone WAL reclamation without undoing cleanup. */ }
      return result;
    } finally { this.store.maintenance = false; }
  }
}
