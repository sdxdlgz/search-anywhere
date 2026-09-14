import { hash } from './security.js';
import type { ExaLogin, Store, StoredKey, StoredLoginSession } from './store.js';
import { boundedBody, GatewayError, type HttpFetch } from './upstream.js';
import { updatedExaCookie } from './exa-cookies.js';
import type { UsageSnapshot } from '../shared/types.js';

const BASE = 'https://dashboard.exa.ai';
type Json = Record<string, unknown>;
type Context = { session: StoredLoginSession; login: ExaLogin; signal: AbortSignal };
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const cents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const invalid = () => new GatewayError('Exa 余额响应字段不完整或格式无效，保留上次快照。', 'invalid_response', 502);
const expired = () => new GatewayError('Exa 官网登录已失效，请更新会话 Cookie；搜索 key 保留。', 'exa_login_expired', 401);
const changed = () => new GatewayError('Exa 登录配置已更换或移除，请重新查询。', 'usage_context_changed', 409);

export class ExaBalance {
  private pending = new Map<string, Promise<UsageSnapshot>>();
  constructor(private store: Store, private http: HttpFetch) {}

  usage(key: StoredKey): Promise<UsageSnapshot> {
    const previous = this.pending.get(key.id);
    if (previous) return previous;
    const task = this.query(key).finally(() => this.pending.delete(key.id));
    this.pending.set(key.id, task); return task;
  }

  private current(context: Context) {
    if (this.store.loginSession(context.session.key_id)?.version !== context.session.version) throw changed();
  }

  private persist(context: Context, cookie: string, expiresAt = context.session.expires_at) {
    this.current(context);
    const login = { ...context.login, cookie };
    if (!this.store.rotateExaSession(context.session, login, expiresAt)) throw changed();
    context.session = this.store.loginSession(context.session.key_id)!;
    context.login = login;
  }

  private async request(context: Context, path: string, searchKey?: string): Promise<Json> {
    this.current(context);
    try {
      const response = await this.http(searchKey ? 'https://api.exa.ai/v0/teams/me' : BASE + path, {
        method: 'GET', redirect: 'manual', signal: context.signal,
        headers: searchKey ? { 'x-api-key': searchKey, Accept: 'application/json' } : { Cookie: context.login.cookie, Accept: 'application/json' },
      });
      this.current(context);
      if (!searchKey) {
        const updated = updatedExaCookie(context.login.cookie, response.headers);
        if (updated.changed) this.persist(context, updated.cookie);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (!searchKey && (response.status === 401 || (response.status >= 300 && response.status < 400))) throw expired();
        const message = searchKey ? 'Exa 无法核对搜索 key 所属团队' : response.status === 403 ? 'Exa 官网会话没有此团队的余额读取权限' : 'Exa 余额服务请求失败';
        throw new GatewayError(`${message}（HTTP ${response.status}）。`, response.status === 429 ? 'rate_limited' : 'exa_http_error', response.status);
      }
      const data = object(JSON.parse(Buffer.from(await boundedBody(response)).toString('utf8')));
      this.current(context);
      if (!data || 'error' in data) throw invalid();
      return data;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(context.signal.aborted ? 'Exa 余额查询超时，请稍后重试。' : 'Exa 余额服务连接失败或响应格式无效。', context.signal.aborted ? 'timeout' : 'connection_error', context.signal.aborted ? 504 : 502);
    }
  }

  private async query(key: StoredKey): Promise<UsageSnapshot> {
    const session = this.store.loginSession(key.id);
    if (!session) return { status: 'needs_setup', source: 'unknown', synced_at: new Date().toISOString(), message: '请配置 Exa 官网会话 Cookie 与 Team ID 以查询余额。' };
    if (session.needs_login) throw expired();
    const context: Context = { session, login: this.store.exaLogin(session), signal: AbortSignal.timeout(45000) };
    try {
      const data = await this.request(context, '/api/auth/session');
      const teamId = object(data.user)?.currentTeamId;
      if (!data.user) throw expired();
      if (typeof teamId !== 'string' || typeof data.expires !== 'string' || !Number.isFinite(Date.parse(data.expires))) throw invalid();
      if (Date.parse(data.expires) <= Date.now()) throw expired();
      this.persist(context, context.login.cookie, new Date(data.expires).toISOString());
      if (teamId !== context.login.team_id) throw new GatewayError('Exa Cookie 当前团队与填写的 Team ID 不一致，请在官网选中正确团队后重新复制 Cookie。', 'exa_team_mismatch', 409);
      const keyTeam = await this.request(context, '', this.store.secret(key));
      if (typeof keyTeam.id !== 'string') throw invalid();
      if (keyTeam.id !== teamId) throw new GatewayError('此 Exa 搜索 key 与官网登录团队不一致，未采纳余额。', 'exa_team_mismatch', 409);
      const plan = await this.request(context, '/api/orb/get-orb-plan');
      const balance = await this.request(context, '/api/get-credits');
      this.current(context);
      return exaBalanceSnapshot(balance, plan, teamId);
    } catch (error) {
      this.current(context);
      if (error instanceof GatewayError && ['exa_login_expired', 'exa_team_mismatch'].includes(error.code)) this.store.invalidateLoginSession(context.session);
      throw error;
    }
  }
}

export function exaBalanceSnapshot(data: Json, plan: Json, teamId: string): UsageSnapshot {
  const credits = data.orbCreditsInCents, debt = data.orbInvoiceDebt;
  if (!cents(credits) || !cents(debt) || debt < 0 || !Array.isArray(data.expiringCredits) || data.expiringCredits.length > 1000 || 'error' in plan || !('subscription' in plan)) throw invalid();
  const subscription = object(plan.subscription);
  const external = object(subscription?.plan)?.external_plan_id;
  if (plan.subscription !== null && (typeof external !== 'string' || !external)) throw invalid();
  const enterprise = external === 'search_api_enterprise' || external === 'search_websets';
  const available = enterprise ? Math.max(credits, 0) : credits - debt;
  if (!cents(available)) throw invalid();
  const expiring = data.expiringCredits.map(entry => {
    const item = object(entry);
    if (!item || !cents(item.balanceCents) || item.balanceCents < 0 || typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))) throw invalid();
    return { balance_cents: item.balanceCents, expires_at: new Date(item.expiresAt).toISOString() };
  });
  return { status: 'ok', source: 'official', synced_at: new Date().toISOString(), money_balance: {
    credits_cents: credits, invoice_debt_cents: debt, available_cents: available,
    scope: hash(`exa:${teamId}`), enterprise, expiring,
  }, message: 'Exa 官网团队余额，按官方套餐规则显示美元金额；到期额度是现有余额的一部分，不另行累计。' };
}
