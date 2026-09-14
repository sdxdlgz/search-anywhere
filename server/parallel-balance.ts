import type { UsageSnapshot } from '../shared/types.js';
import { hash } from './security.js';
import type { Store, StoredKey, StoredLoginSession } from './store.js';
import { GatewayError, type HttpFetch } from './upstream.js';
import { accountRequest, parseParallelTokens, type Json } from './parallel-account.js';

const expired = () => new GatewayError('Parallel 余额授权已失效，请重新在官网授权；搜索 key 不受影响。', 'parallel_login_expired', 401);
const changed = () => new GatewayError('Parallel 授权已更换或移除，请重新查询。', 'usage_context_changed', 409);

export class ParallelBalance {
  private pending = new Map<string, Promise<UsageSnapshot>>();
  constructor(private store: Store, private http: HttpFetch) {}
  usage(key: StoredKey): Promise<UsageSnapshot> {
    const previous = this.pending.get(key.id);
    if (previous) return previous;
    const task = this.query(key).finally(() => this.pending.delete(key.id));
    this.pending.set(key.id, task); return task;
  }
  private current(session: StoredLoginSession) {
    if (this.store.loginSession(session.key_id)?.version !== session.version) throw changed();
  }
  private invalidate(session: StoredLoginSession): never { this.store.invalidateLoginSession(session); throw expired(); }
  private async refresh(session: StoredLoginSession, signal: AbortSignal): Promise<StoredLoginSession> {
    this.current(session);
    const old = this.store.parallelTokens(session);
    if (old.refresh_expires_at !== undefined && old.refresh_expires_at * 1000 <= Date.now()) return this.invalidate(session);
    let data: Json;
    try { data = await accountRequest(this.http, 'token', signal, { grant_type: 'refresh_token', refresh_token: old.refresh_token, client_id: old.client_id }); }
    catch (error) {
      this.current(session);
      if (error instanceof GatewayError && ['invalid_grant', 'expired_token', 'access_denied', 'parallel_login_expired'].includes(error.code)) return this.invalidate(session);
      throw error;
    }
    this.current(session);
    let tokens;
    try { tokens = parseParallelTokens(data, old.client_id, old); }
    catch (error) { if (error instanceof GatewayError && error.code === 'parallel_org_mismatch') this.store.invalidateLoginSession(session); throw error; }
    if (!this.store.rotateLoginSession(session, tokens)) throw changed();
    return this.store.loginSession(session.key_id)!;
  }
  private async query(key: StoredKey): Promise<UsageSnapshot> {
    let session = this.store.loginSession(key.id);
    if (!session) return { status: 'needs_setup', source: 'unknown', synced_at: new Date().toISOString(), message: '请打开此 Parallel key 的登录凭证配置，在官网授权读取组织余额。免费 MCP 不需要余额授权。' };
    if (session.needs_login) throw expired();
    const authorizationExpiry = this.store.parallelTokens(session).authorization_expires_at;
    if (authorizationExpiry !== undefined && authorizationExpiry * 1000 <= Date.now()) return this.invalidate(session);
    const signal = AbortSignal.timeout(45000);
    let refreshed = false;
    if (Date.parse(session.expires_at) <= Date.now() + 60000) { session = await this.refresh(session, signal); refreshed = true; }
    try { return await this.readBalance(session, signal); }
    catch (error) {
      this.current(session);
      if (!(error instanceof GatewayError) || error.code !== 'parallel_login_expired') throw error;
      if (refreshed) return this.invalidate(session);
    }
    session = await this.refresh(session, signal);
    try { return await this.readBalance(session, signal); }
    catch (error) {
      this.current(session);
      if (error instanceof GatewayError && error.code === 'parallel_login_expired') return this.invalidate(session);
      throw error;
    }
  }
  private async readBalance(session: StoredLoginSession, signal: AbortSignal): Promise<UsageSnapshot> {
    this.current(session);
    const tokens = this.store.parallelTokens(session);
    const data = await accountRequest(this.http, 'balance', signal, undefined, tokens.access_token);
    this.current(session);
    if (data.org_id !== tokens.org_id) { this.store.invalidateLoginSession(session); throw new GatewayError('Parallel 余额组织与已授权组织不一致，未采纳快照；请重新授权对应组织。', 'parallel_org_mismatch', 409); }
    if (typeof data.credit_balance_cents !== 'number' || !Number.isFinite(data.credit_balance_cents) ||
        typeof data.pending_debit_balance_cents !== 'number' || !Number.isFinite(data.pending_debit_balance_cents) || typeof data.will_invoice !== 'boolean') throw new GatewayError('Parallel 余额响应缺少有效金额或计费方式，保留上次快照。', 'invalid_response');
    return { status: 'ok', source: 'official', synced_at: new Date().toISOString(), organization_balance: {
      credits_cents: data.credit_balance_cents, pending_debit_cents: data.pending_debit_balance_cents,
      postpaid: data.will_invoice, scope: hash(`parallel:${tokens.org_id}`),
    }, message: '已授权组织的官方余额；不是 key 级额度。待扣金额单独保留，未从余额重复扣减；后付费组织的零金额不表示额度耗尽。' };
  }
}
