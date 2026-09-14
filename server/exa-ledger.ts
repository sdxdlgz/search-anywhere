import { randomUUID } from 'node:crypto';
import { hash } from './security.js';
import type { Store, StoredKey } from './store.js';
import type { KeyPublic, UsageSnapshot } from '../shared/types.js';
import { GatewayError } from './upstream.js';

type Preference = { key_id: string; mode: 'official' | 'manual'; scope: string | null; version: string };
type Calibration = { scope: string; team_id: string; amount_micro: number; call_cursor: number; calibrated_at: string };
type Block = { key_id: string; generation: string; reason: 'challenge' | 'rate_limited'; retry_at: string | null; message: string };
const micro = (usd: number) => Math.round(usd * 1000000);

// Public standard prices checked 2026-09-14; response costDollars takes precedence.
export function estimateExaCost(mode: string, operation: string, returnedResults: number): number | null {
  if (operation === 'fetch') return returnedResults * 0.001; // Current adapter requests text only.
  const base: Record<string, number> = { instant: 7000, fast: 7000, auto: 7000, 'deep-lite': 12000, deep: 12000, 'deep-reasoning': 15000 };
  if (!(mode in base)) return null;
  return (base[mode] + Math.max(0, returnedResults - 10) * 1000) / 1000000;
}

export class ExaLedger {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS exa_balance_preferences (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        mode TEXT NOT NULL, scope TEXT, version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exa_balance_calibrations (
        scope TEXT PRIMARY KEY, team_id TEXT NOT NULL, amount_micro INTEGER NOT NULL,
        call_cursor INTEGER NOT NULL, calibrated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exa_usage_blocks (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        generation TEXT NOT NULL, reason TEXT NOT NULL, retry_at TEXT, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_billing_scope ON calls(billing_scope);
    `);
  }
  preference(id: string) { return this.store.get<Preference>('SELECT * FROM exa_balance_preferences WHERE key_id=?', id); }
  isManual(id: string) { return this.preference(id)?.mode === 'manual'; }
  scope(id: string): string {
    const preference = this.preference(id);
    if (preference?.mode === 'manual' && preference.scope) return preference.scope;
    const session = this.store.loginSession(id);
    return session ? hash(`exa:${this.store.exaLogin(session).team_id}`) : hash(`exa:key:${id}`);
  }
  configure(id: string, input: { mode: 'official' | 'manual'; balance_usd?: number; team_id?: string }) {
    if (this.store.key(id)?.provider !== 'exa') throw new GatewayError('仅 Exa 支持此余额配置。', 'invalid_provider', 400);
    this.store.transaction(() => {
      let scope: string | null = null;
      if (input.mode === 'manual') {
        const amount = input.balance_usd;
        if (amount === undefined || !Number.isFinite(amount) || Math.abs(amount) > 1000000 || Math.abs(amount * 1000000 - micro(amount)) > Number.EPSILON * Math.max(1, Math.abs(amount * 1000000)) * 4) throw new GatewayError('请输入有效的美元余额，最多 6 位小数。', 'invalid_balance', 400);
        const team = input.team_id?.trim() || '';
        if (team.length > 100 || /\s/.test(team)) throw new GatewayError('Team ID 格式无效。', 'invalid_team', 400);
        scope = team ? hash(`exa:${team}`) : hash(`exa:key:${id}`);
        const running = this.store.get<{ n: number }>("SELECT COUNT(*) n FROM calls WHERE status='running' AND (key_id=? OR billing_scope=?)", id, scope)!.n;
        if (running) throw new GatewayError('此余额关联的调用尚未结束，请完成后再校准。', 'balance_busy', 409);
        const cursor = this.store.get<{ n: number }>('SELECT COALESCE(MAX(rowid),0) n FROM calls')!.n;
        this.store.run(`INSERT INTO exa_balance_calibrations VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
          team_id=excluded.team_id,amount_micro=excluded.amount_micro,call_cursor=excluded.call_cursor,calibrated_at=excluded.calibrated_at`, scope, team, micro(amount), cursor, new Date().toISOString());
      }
      this.store.run(`INSERT INTO exa_balance_preferences VALUES(?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET
        mode=excluded.mode,scope=excluded.scope,version=excluded.version`, id, input.mode, scope, randomUUID());
      this.store.run('UPDATE credentials SET usage_error=NULL WHERE id=?', id);
    });
  }
  manualUsage(id: string): UsageSnapshot | undefined {
    const preference = this.preference(id);
    if (preference?.mode !== 'manual' || !preference.scope) return;
    const anchor = this.store.get<Calibration>('SELECT * FROM exa_balance_calibrations WHERE scope=?', preference.scope);
    if (!anchor) throw new GatewayError('本地余额校准记录缺失，请重新校准。', 'missing_calibration', 409);
    const usage = this.store.get<{ reported: number; estimated: number; unknown: number }>(`SELECT
      COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND billing_source='reported' THEN ROUND(cost_usd*1000000) ELSE 0 END),0) reported,
      COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND billing_source!='reported' THEN ROUND(cost_usd*1000000) ELSE 0 END),0) estimated,
      COALESCE(SUM(cost_usd IS NULL),0) unknown FROM calls WHERE billing_scope=? AND rowid>?`, anchor.scope, anchor.call_cursor)!;
    const deducted = usage.reported + usage.estimated;
    return { status: 'ok', source: 'estimated', synced_at: new Date().toISOString(), local_balance: {
      scope: anchor.scope, baseline_usd: anchor.amount_micro / 1000000, remaining_usd: (anchor.amount_micro - deducted) / 1000000,
      deducted_usd: deducted / 1000000, reported_usd: usage.reported / 1000000, estimated_usd: usage.estimated / 1000000,
      unpriced_calls: usage.unknown, calibrated_at: anchor.calibrated_at,
    }, message: '手动校准后仅扣除本网关记录的费用；上游 costDollars 也是费用估计，最终账单以官网为准。外部消费、充值、赠额及到期需重新校准。' };
  }
  block(id: string): Block | undefined {
    const block = this.store.get<Block>('SELECT * FROM exa_usage_blocks WHERE key_id=?', id);
    const generation = this.store.loginSession(id)?.generation || 'service';
    return block?.generation === generation ? block : undefined;
  }
  pause(id: string, reason: Block['reason'], message: string, retryAt: string | null = null) {
    this.store.run(`INSERT INTO exa_usage_blocks VALUES(?,?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET
      generation=excluded.generation,reason=excluded.reason,retry_at=excluded.retry_at,message=excluded.message`,
    id, this.store.loginSession(id)?.generation || 'service', reason, retryAt, message);
  }
  clearBlock(id: string) { this.store.run('DELETE FROM exa_usage_blocks WHERE key_id=?', id); }
  autoPaused(id: string) {
    const block = this.block(id);
    return this.isManual(id) || !!block && (block.reason === 'challenge' || !!block.retry_at && Date.parse(block.retry_at) > Date.now());
  }
  publicState(key: StoredKey): KeyPublic['exa_balance'] {
    const preference = this.preference(key.id), block = this.block(key.id);
    const anchor = preference?.scope ? this.store.get<Calibration>('SELECT * FROM exa_balance_calibrations WHERE scope=?', preference.scope) : undefined;
    return { mode: preference?.mode || 'official', team_id: anchor?.team_id || '',
      ...(block && preference?.mode !== 'manual' ? { pause_reason: block.reason, retry_at: block.retry_at, auto_paused: this.autoPaused(key.id) } : {}) };
  }
}
