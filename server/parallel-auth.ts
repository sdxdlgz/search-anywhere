import { randomUUID } from 'node:crypto';
import { arch, type as osType } from 'node:os';
import type { ParallelAuthorization, ParallelAuthPoll } from '../shared/types.js';
import type { Store } from './store.js';
import { GatewayError, type HttpFetch } from './upstream.js';
import { accountRequest, identifier, PARALLEL_PLATFORM, parseParallelTokens } from './parallel-account.js';

type Flow = { id: string; keyId: string; account: string; generation: string | null; clientId: string; deviceCode: string; interval: number; nextPoll: number; expires: number; connected: boolean; public?: ParallelAuthorization; pending?: Promise<ParallelAuthPoll> };
const changed = () => new GatewayError('授权请求已取消或配置已变化，请重新开始。', 'usage_context_changed', 409);
const seconds = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 86400) throw new GatewayError('Parallel 授权有效期或轮询间隔无效。', 'invalid_response');
  return Math.ceil(value);
};

export class ParallelAuth {
  private flows = new Map<string, Flow>();
  private starts = new Map<string, Promise<ParallelAuthorization>>();
  private registration?: Promise<string>;
  constructor(private store: Store, private http: HttpFetch) {}
  private current(flow: Flow) {
    const key = this.store.key(flow.keyId);
    if (this.flows.get(flow.keyId) !== flow) throw changed();
    if (!key || key.account !== flow.account || (this.store.loginSession(flow.keyId)?.generation ?? null) !== flow.generation) { this.flows.delete(flow.keyId); throw changed(); }
  }
  private async clientId(): Promise<string> {
    const saved = this.store.parallelClientId();
    if (saved) return saved;
    if (this.registration) return this.registration;
    this.registration = (async () => {
      const data = await accountRequest(this.http, 'register', AbortSignal.timeout(20000), { client_name: 'Search Anywhere balance', platform: { machine: arch(), system: osType() } });
      if (!identifier(data.client_id)) throw new GatewayError('Parallel 未返回有效客户端标识。', 'invalid_response');
      this.store.setParallelClientId(data.client_id); return data.client_id;
    })();
    try { return await this.registration; } finally { this.registration = undefined; }
  }
  start(keyId: string): Promise<ParallelAuthorization> {
    const pending = this.starts.get(keyId);
    if (pending) return pending;
    for (const [id, flow] of this.flows) if (flow.expires <= Date.now()) this.flows.delete(id);
    const key = this.store.key(keyId);
    if (!key || key.provider !== 'parallel') return Promise.reject(new GatewayError('请选择一个 Parallel key。', 'invalid_provider', 400));
    if (this.flows.size >= 100 && !this.flows.has(keyId)) return Promise.reject(new GatewayError('待授权请求过多，请等待已有请求结束。', 'busy', 429));
    const existing = this.flows.get(keyId);
    if (existing?.public && !existing.connected) { this.current(existing); return Promise.resolve(existing.public); }
    const flow: Flow = { id: randomUUID(), keyId, account: key.account, generation: this.store.loginSession(keyId)?.generation ?? null,
      clientId: '', deviceCode: '', interval: 5, nextPoll: 0, expires: Date.now() + 60000, connected: false };
    this.flows.set(keyId, flow);
    const task = this.initialize(flow).catch(error => { if (this.flows.get(keyId) === flow) this.flows.delete(keyId); throw error; }).finally(() => this.starts.delete(keyId));
    this.starts.set(keyId, task); return task;
  }
  private async initialize(flow: Flow): Promise<ParallelAuthorization> {
    flow.clientId = await this.clientId();
    this.current(flow);
    const data = await accountRequest(this.http, 'device/code', AbortSignal.timeout(20000), { client_id: flow.clientId, scope: 'balance:read' });
    this.current(flow);
    if (typeof data.device_code !== 'string' || data.device_code.length < 8 || data.device_code.length > 4096 || /\s/.test(data.device_code) || typeof data.user_code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(data.user_code)) throw new GatewayError('Parallel 未返回有效授权码。', 'invalid_response');
    let url: URL;
    try { url = new URL(String(data.verification_uri_complete || data.verification_uri)); } catch { throw new GatewayError('Parallel 授权网址无效。', 'invalid_response'); }
    if (url.origin !== PARALLEL_PLATFORM || url.pathname !== '/getServiceKeys/device' || url.username || url.password) throw new GatewayError('Parallel 返回了未受信任的授权网址。', 'invalid_response');
    url.search = new URLSearchParams({ user_code: data.user_code }).toString(); url.hash = '';
    flow.deviceCode = data.device_code; flow.interval = seconds(data.interval, 5); flow.nextPoll = Date.now() + flow.interval * 1000;
    flow.expires = Date.now() + seconds(data.expires_in, 600) * 1000;
    flow.public = { id: flow.id, user_code: data.user_code, verification_uri: url.toString(), expires_at: new Date(flow.expires).toISOString(), poll_after_seconds: flow.interval };
    return flow.public;
  }
  cancel(keyId: string, id?: string) { if (!id || this.flows.get(keyId)?.id === id) this.flows.delete(keyId); }
  poll(keyId: string, id: string): Promise<ParallelAuthPoll> {
    const flow = this.flows.get(keyId);
    if (!flow || flow.id !== id) return Promise.reject(changed());
    this.current(flow);
    if (flow.connected) return Promise.resolve({ status: 'connected' });
    if (flow.expires <= Date.now()) { this.cancel(keyId, id); return Promise.reject(new GatewayError('Parallel 授权码已过期，请重新开始。', 'expired_token', 410)); }
    if (flow.pending) return flow.pending;
    if (flow.nextPoll > Date.now()) return Promise.resolve(this.waiting(flow));
    flow.nextPoll = Date.now() + flow.interval * 1000;
    const task = this.exchange(flow).finally(() => { flow.pending = undefined; });
    flow.pending = task; return task;
  }
  private waiting(flow: Flow): ParallelAuthPoll { return { status: 'pending', poll_after_seconds: Math.max(1, Math.ceil((flow.nextPoll - Date.now()) / 1000)) }; }
  private async exchange(flow: Flow): Promise<ParallelAuthPoll> {
    let data;
    try { data = await accountRequest(this.http, 'token', AbortSignal.timeout(20000), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: flow.clientId, device_code: flow.deviceCode }); }
    catch (error) {
      this.current(flow);
      if (!(error instanceof GatewayError)) throw error;
      if (error.code === 'slow_down') { flow.interval += 5; flow.nextPoll = Date.now() + flow.interval * 1000; }
      if (error.code === 'rate_limited') flow.nextPoll = Date.now() + (error.cooldownMs || 60000);
      if (['authorization_pending', 'slow_down', 'rate_limited'].includes(error.code)) return this.waiting(flow);
      if (['access_denied', 'expired_token', 'invalid_grant'].includes(error.code)) {
        this.cancel(flow.keyId, flow.id);
        throw new GatewayError(error.code === 'access_denied' ? '已拒绝 Parallel 授权，可重新开始。' : 'Parallel 授权码已过期或失效，请重新开始。', error.code, 400);
      }
      throw error;
    }
    this.current(flow);
    const tokens = parseParallelTokens(data, flow.clientId);
    this.store.transaction(() => {
      this.store.setLoginSession(flow.keyId, tokens);
      this.store.run('UPDATE credentials SET usage_json=NULL,usage_error=NULL WHERE id=?', flow.keyId);
    });
    flow.generation = this.store.loginSession(flow.keyId)!.generation;
    flow.deviceCode = ''; flow.connected = true;
    return { status: 'connected' };
  }
}
