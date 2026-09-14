import { hash } from './security.js';
import type { KeenableTokens, Store, StoredKey, StoredKeenableSession } from './store.js';
import { boundedBody, GatewayError, type HttpFetch } from './upstream.js';
import type { UsageSnapshot } from '../shared/types.js';

const AUTH = 'https://caqmfcgrdovyjdhfnwzw.supabase.co/auth/v1';
// Public anon key shipped by Keenable's console, not an account credential.
const PUBLIC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcW1mY2dyZG92eWpkaGZud3p3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAwMTc4NTYsImV4cCI6MjA3NTU5Mzg1Nn0.gmf-2JuDTOVL7MAEgMYczSbT1P-PI3X1WOG1SXfhkNg';
const BALANCE = 'https://api.keenable.ai/bff/organization/balance';
const IDENTITY = 'https://api.keenable.ai/v1/auth/user';
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
type Json = Record<string, unknown>;

export function keenableTokens(input: { access_token?: string; refresh_token: string }): KeenableTokens {
  if (!input.access_token) return { access_token: '', refresh_token: input.refresh_token, expires_at: 0 };
  try {
    const parts = input.access_token.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (parts.length !== 3 || claims.iss !== AUTH || !numeric(claims.exp) || claims.exp > 8640000000000) throw new Error('claims');
    // Claims schedule refresh only; the official API verifies the signature.
    return { access_token: input.access_token, refresh_token: input.refresh_token, expires_at: claims.exp };
  } catch { throw new GatewayError('Access token 格式不正确，需使用 Keenable 官网的登录凭证；也可留空只填 refresh token。', 'invalid_login', 400); }
}

export class KeenableBalance {
  private pending = new Map<string, Promise<UsageSnapshot>>();
  constructor(private store: Store, private http: HttpFetch) {}

  usage(key: StoredKey): Promise<UsageSnapshot> {
    const previous = this.pending.get(key.id);
    if (previous) return previous;
    const task = this.query(key).finally(() => this.pending.delete(key.id));
    this.pending.set(key.id, task);
    return task;
  }

  private current(session: StoredKeenableSession) {
    if (this.store.keenableSession(session.key_id)?.version !== session.version) {
      throw new GatewayError('登录凭证已更换或移除，请重新查询用量。', 'usage_context_changed', 409);
    }
  }

  private async request(url: string, headers: Record<string, string>, signal: AbortSignal, body?: Json): Promise<Json> {
    try {
      const response = await this.http(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 429 ? 'rate_limited' : 'keenable_http_error';
        throw new GatewayError(`Keenable 额度服务请求失败（HTTP ${response.status}）。`, code, response.status);
      }
      const data: unknown = JSON.parse(Buffer.from(await boundedBody(response)).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
      return data as Json;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(signal.aborted ? 'Keenable 额度查询超时，请稍后重试。' : 'Keenable 额度服务连接失败或响应格式无效。', signal.aborted ? 'timeout' : 'connection_error', signal.aborted ? 504 : 502);
    }
  }

  private async refresh(session: StoredKeenableSession, signal: AbortSignal): Promise<StoredKeenableSession> {
    this.current(session);
    const previous = this.store.keenableTokens(session);
    let data: Json;
    try {
      data = await this.request(`${AUTH}/token?grant_type=refresh_token`, { apikey: PUBLIC_KEY }, signal, { refresh_token: previous.refresh_token });
    } catch (error) {
      this.current(session);
      if (error instanceof GatewayError && [400, 401, 403].includes(error.status)) {
        this.store.invalidateKeenableSession(session);
        throw new GatewayError('Keenable 登录已失效，请从官网重新获取并更新登录凭证。搜索 key 不受影响。', 'keenable_login_expired', 401);
      }
      throw error;
    }
    if (typeof data.access_token !== 'string' || data.access_token.length > 16384 || typeof data.refresh_token !== 'string' || data.refresh_token.length < 8 || data.refresh_token.length > 4096) {
      throw new GatewayError('Keenable 续期响应缺少有效登录凭证。', 'invalid_response');
    }
    let tokens: KeenableTokens;
    try { tokens = keenableTokens({ access_token: data.access_token, refresh_token: data.refresh_token }); }
    catch { throw new GatewayError('Keenable 续期响应包含无效 access token。', 'invalid_response'); }
    if (tokens.expires_at * 1000 <= Date.now()) throw new GatewayError('Keenable 续期返回的登录凭证已过期。', 'invalid_response');
    // Save both replacements before any subsequent network operation, even if balance fails.
    if (!this.store.rotateKeenableSession(session, tokens)) throw new GatewayError('登录凭证已更换或移除，请重新查询用量。', 'usage_context_changed', 409);
    return this.store.keenableSession(session.key_id)!;
  }

  private async query(key: StoredKey): Promise<UsageSnapshot> {
    let session = this.store.keenableSession(key.id);
    if (!session) return { status: 'needs_setup', source: 'unknown', synced_at: new Date().toISOString(), message: '请为此 Keenable key 配置官网登录凭证，才能查询官方余额。' };
    if (session.needs_login) throw new GatewayError('Keenable 登录已失效或账号不匹配，请更新登录凭证。搜索 key 不受影响。', 'keenable_login_expired', 401);
    const signal = AbortSignal.timeout(45000);
    const identity = await this.request(IDENTITY, { 'X-API-Key': this.store.secret(key) }, signal);
    if (typeof identity.org_id !== 'string' || !identity.org_id) throw new GatewayError('Keenable 搜索 key 的组织身份无法确认。', 'invalid_response');
    let refreshed = false;
    if (Date.parse(session.expires_at) <= Date.now() + 60000) { session = await this.refresh(session, signal); refreshed = true; }
    this.current(session);
    let data: Json;
    try { data = await this.request(BALANCE, { Authorization: `Bearer ${this.store.keenableTokens(session).access_token}` }, signal); }
    catch (error) {
      if (!(error instanceof GatewayError) || error.status !== 401) throw error;
      if (refreshed) { this.store.invalidateKeenableSession(session); throw new GatewayError('Keenable 续期后仍拒绝访问，请更新登录凭证。', 'keenable_login_expired', 401); }
      session = await this.refresh(session, signal);
      data = await this.afterRefreshBalance(session, signal);
    }
    this.current(session);
    if (typeof data.org_id !== 'string' || !data.org_id) throw new GatewayError('Keenable 余额响应缺少组织身份，未计入额度。', 'invalid_response');
    if (data.org_id !== identity.org_id) {
      this.store.invalidateKeenableSession(session);
      throw new GatewayError('官网登录账号与此搜索 key 的组织不一致，未采纳余额；请更新对应账号的登录凭证。', 'keenable_account_mismatch', 409);
    }
    const spending = [data.search_spendings, data.fetch_spendings, data.workflow_spendings];
    const charged = data.charged_spendings ?? (spending.every(numeric) ? (spending as number[]).reduce((sum, n) => sum + n, 0) : undefined);
    if (!numeric(data.free_credits) || !numeric(charged) || !numeric(data.paid_credits)) throw new GatewayError('Keenable 余额响应缺少有效额度字段，保留上次快照。', 'invalid_response');
    return { status: 'ok', source: 'official', synced_at: new Date().toISOString(),
      balance: { free_limit: data.free_credits, charged_used: charged, free_remaining: Math.max(0, data.free_credits - charged), paid_remaining: data.paid_credits, scope: hash(`keenable:${data.org_id}`) },
      message: '官网组织余额，单位为 credits；免费额度与付费余额分开统计，不等于搜索次数。' };
  }

  private async afterRefreshBalance(session: StoredKeenableSession, signal: AbortSignal): Promise<Json> {
    try { return await this.request(BALANCE, { Authorization: `Bearer ${this.store.keenableTokens(session).access_token}` }, signal); }
    catch (error) {
      if (error instanceof GatewayError && error.status === 401) {
        this.store.invalidateKeenableSession(session);
        throw new GatewayError('Keenable 续期后仍拒绝访问，请更新登录凭证。', 'keenable_login_expired', 401);
      }
      throw error;
    }
  }
}
