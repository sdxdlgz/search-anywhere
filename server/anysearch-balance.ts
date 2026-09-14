import { hash, safeEqual } from './security.js';
import type { LoginTokens, Store, StoredKey, StoredLoginSession } from './store.js';
import { boundedBody, GatewayError, type HttpFetch } from './upstream.js';
import type { UsageSnapshot } from '../shared/types.js';

const BASE = 'https://www.anysearch.com';
const REFRESH = '/api/auth/refresh';
const expiredCodes = new Set([40101, 40141]);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined;
const changed = () => new GatewayError('登录凭证已更换或移除，请重新查询用量。', 'usage_context_changed', 409);
const loginExpired = () => new GatewayError('AnySearch 登录已失效，请更新官网登录凭证。搜索 key 不受影响。', 'anysearch_login_expired', 401);

export function anysearchTokens(input: { access_token?: string; refresh_token: string }): LoginTokens {
  if (!input.access_token) return { access_token: '', refresh_token: input.refresh_token, expires_at: 0 };
  try {
    const parts = input.access_token.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (parts.length !== 3 || claims.iss !== 'https://auth.anysearch.com' || claims.product_line !== 'anysearch' || !count(claims.exp) || claims.exp > 8640000000000) throw new Error('claims');
    // The official endpoints verify identity; exp is only a refresh scheduling hint.
    return { access_token: input.access_token, refresh_token: input.refresh_token, expires_at: claims.exp };
  } catch { throw new GatewayError('Access token 格式不正确，需使用 AnySearch 官网的登录凭证；也可留空只填 refresh token。', 'invalid_login', 400); }
}

export class AnySearchBalance {
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

  private async request(path: string, signal: AbortSignal, access?: string, body?: Json): Promise<Json> {
    try {
      const response = await this.http(BASE + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw loginExpired();
        throw new GatewayError(`AnySearch 额度服务请求失败（HTTP ${response.status}）。`, response.status === 429 ? 'rate_limited' : 'anysearch_http_error', response.status);
      }
      const envelope = object(JSON.parse(Buffer.from(await boundedBody(response)).toString('utf8')));
      if (expiredCodes.has(Number(envelope?.code))) throw loginExpired();
      if (!envelope || (envelope.code !== 0 && envelope.code !== 200)) throw new GatewayError('AnySearch 额度服务返回业务错误，未采纳响应。', 'upstream_error');
      const data = object(envelope.data);
      if (!data) throw new GatewayError('AnySearch 额度服务返回的数据格式无效。', 'invalid_response');
      return data;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(signal.aborted ? 'AnySearch 额度查询超时，请稍后重试。' : 'AnySearch 额度服务连接失败或响应格式无效。', signal.aborted ? 'timeout' : 'connection_error', signal.aborted ? 504 : 502);
    }
  }

  private async refresh(session: StoredLoginSession, signal: AbortSignal): Promise<StoredLoginSession> {
    this.current(session);
    let data: Json;
    try { data = await this.request(REFRESH, signal, undefined, { refresh_token: this.store.loginTokens(session).refresh_token }); }
    catch (error) {
      this.current(session);
      if (error instanceof GatewayError && [400, 401, 403].includes(error.status)) { this.store.invalidateLoginSession(session); throw loginExpired(); }
      throw error;
    }
    if (typeof data.access_token !== 'string' || data.access_token.length > 16384 || typeof data.refresh_token !== 'string' || data.refresh_token.length < 8 || data.refresh_token.length > 4096 || /\s/.test(data.refresh_token) || !count(data.expires_in_seconds) || data.expires_in_seconds === 0) {
      throw new GatewayError('AnySearch 续期响应缺少有效凭证或有效期。', 'invalid_response');
    }
    let tokens: LoginTokens;
    try { tokens = anysearchTokens({ access_token: data.access_token, refresh_token: data.refresh_token }); }
    catch { throw new GatewayError('AnySearch 续期返回的 access token 无效。', 'invalid_response'); }
    tokens.expires_at = Math.min(tokens.expires_at, Math.floor(Date.now() / 1000) + data.expires_in_seconds);
    if (tokens.expires_at * 1000 <= Date.now()) throw new GatewayError('AnySearch 续期返回的登录凭证已过期。', 'invalid_response');
    // Rotation must survive a later quota failure or process restart.
    if (!this.store.rotateLoginSession(session, tokens)) throw changed();
    return this.store.loginSession(session.key_id)!;
  }

  private async query(key: StoredKey): Promise<UsageSnapshot> {
    let session = this.store.loginSession(key.id);
    if (!session) return { status: 'needs_setup', source: 'unknown', synced_at: new Date().toISOString(), message: '请为此 AnySearch key 配置官网登录凭证，才能查询官方请求额度。' };
    if (session.needs_login) throw loginExpired();
    const signal = AbortSignal.timeout(45000);
    let refreshed = false;
    if (Date.parse(session.expires_at) <= Date.now() + 60000) { session = await this.refresh(session, signal); refreshed = true; }
    try { return await this.readQuota(key, session, signal); }
    catch (error) {
      this.current(session);
      if (!(error instanceof GatewayError) || error.code !== 'anysearch_login_expired') throw error;
      if (refreshed) { this.store.invalidateLoginSession(session); throw error; }
    }
    session = await this.refresh(session, signal);
    try { return await this.readQuota(key, session, signal); }
    catch (error) {
      this.current(session);
      if (error instanceof GatewayError && error.code === 'anysearch_login_expired') this.store.invalidateLoginSession(session);
      throw error;
    }
  }

  private async readQuota(key: StoredKey, session: StoredLoginSession, signal: AbortSignal): Promise<UsageSnapshot> {
    this.current(session);
    const access = this.store.loginTokens(session).access_token;
    const me = await this.request('/api/auth/me', signal, access);
    if (me.logged_in !== true) throw loginExpired();
    const user = object(me.user);
    if (typeof user?.auth_user_id !== 'string' || !user.auth_user_id) throw new GatewayError('AnySearch 登录账号身份无法确认。', 'invalid_response');
    const list = await this.request('/api/user/keys', signal, access);
    if (!Array.isArray(list.keys)) throw new GatewayError('AnySearch 密钥列表格式无效，无法核对账号归属。', 'invalid_response');
    const secret = this.store.secret(key);
    const match = list.keys.map(object).find(k => typeof k?.key === 'string' && safeEqual(k.key, secret));
    if (!match) {
      this.current(session); this.store.invalidateLoginSession(session);
      throw new GatewayError('官网登录账号下未找到此 AnySearch key，未采纳额度；请配置对应账号的登录凭证。', 'anysearch_account_mismatch', 409);
    }
    const quota = await this.request('/api/user/billing/overview', signal, access);
    this.current(session);
    return parseQuota(quota, match, user.auth_user_id);
  }
}

function parseQuota(data: Json, key: Json, account: string): UsageSnapshot {
  if (!count(data.total) || !count(data.used) || !count(data.remaining) || !['daily', 'monthly', 'none'].includes(String(data.reset_period)) || typeof data.tier_name !== 'string' || typeof data.usage_stats_available !== 'boolean') {
    throw new GatewayError('AnySearch 额度响应缺少有效额度或周期字段，保留上次快照。', 'invalid_response');
  }
  if (!count(key.quota_used) || typeof key.quota_is_unlimited !== 'boolean' || (!key.quota_is_unlimited && !count(key.quota_limit))) throw new GatewayError('AnySearch key 限额响应格式无效。', 'invalid_response');
  if (data.next_reset_at != null && (typeof data.next_reset_at !== 'string' || !Number.isFinite(Date.parse(data.next_reset_at)))) throw new GatewayError('AnySearch 重置时间格式无效。', 'invalid_response');
  return { status: 'ok', source: 'official', synced_at: new Date().toISOString(), request_quota: {
    total: data.total, used: data.used, remaining: data.remaining, scope: hash(`anysearch:${account}`), tier: data.tier_name,
    reset_period: data.reset_period as 'daily' | 'monthly' | 'none', next_reset_at: data.next_reset_at ? new Date(String(data.next_reset_at)).toISOString() : null,
    key_used: key.quota_used, key_limit: key.quota_is_unlimited ? null : key.quota_limit as number,
    total_calls: data.usage_stats_available && count(data.total_calls) ? data.total_calls : null,
    month_calls: data.usage_stats_available && count(data.current_month_calls) ? data.current_month_calls : null,
  }, message: '官网账号请求额度，单位为次；账号额度与 key 限额分开显示，剩余按官方返回值记录。' };
}
