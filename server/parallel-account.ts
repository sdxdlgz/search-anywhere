import type { ParallelTokens } from './store.js';
import { boundedBody, GatewayError, responseError, type HttpFetch } from './upstream.js';

export type Json = Record<string, unknown>;
export const PARALLEL_PLATFORM = 'https://platform.parallel.ai';
export const PARALLEL_BALANCE = 'https://api.parallel.ai/account/service/v1/balance';
export const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const validSecret = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 8 && value.length <= max && !/\s/.test(value);
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3153600000;
const oauthErrors = new Set(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_client', 'invalid_scope']);

export async function accountRequest(http: HttpFetch, path: 'register' | 'device/code' | 'token' | 'balance', signal: AbortSignal, body?: Json, access?: string): Promise<Json> {
  try {
    const url = path === 'balance' ? PARALLEL_BALANCE : `${PARALLEL_PLATFORM}/getServiceKeys/${path}`;
    const response = await http(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': path === 'register' ? 'application/json' : 'application/x-www-form-urlencoded' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: body ? path === 'register' ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString() : undefined });
    let data: Json = {};
    const bytes = await boundedBody(response);
    try { data = object(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { if (response.ok) throw new GatewayError('Parallel 账号接口返回格式无效。', 'invalid_response'); }
    const oauthCode = typeof data.error === 'string' && oauthErrors.has(data.error) ? data.error : null;
    if (!response.ok || data.error) {
      const code = oauthCode || (response.status === 401 ? 'parallel_login_expired' : response.status === 429 ? 'rate_limited' : 'parallel_http_error');
      throw new GatewayError(`Parallel 账号接口请求失败（HTTP ${response.status}）。`, code, response.ok ? 502 : response.status, false, response.status === 429 ? responseError(response).cooldownMs : 0);
    }
    return data;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(signal.aborted ? 'Parallel 账号请求超时，请稍后重试。' : 'Parallel 账号服务连接失败。', signal.aborted ? 'timeout' : 'connection_error', signal.aborted ? 504 : 502);
  }
}

export function parseParallelTokens(data: Json, clientId: string, previous?: ParallelTokens): ParallelTokens {
  const refresh = data.refresh_token ?? previous?.refresh_token;
  const orgId = data.org_id ?? previous?.org_id;
  if (!validSecret(data.access_token, 16384) || !validSecret(refresh, 4096) || !identifier(orgId) || !duration(data.expires_in) || data.expires_in <= 0 ||
      (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))) throw new GatewayError('Parallel 授权响应缺少有效凭证、组织或有效期。', 'invalid_response');
  if (previous && orgId !== previous.org_id) throw new GatewayError('Parallel 续期返回了不同组织，未接受凭证。', 'parallel_org_mismatch', 409);
  const now = Date.now() / 1000;
  const expiry = (name: string, fallback?: number) => {
    if (data[name] === undefined) return fallback;
    if (!duration(data[name])) throw new GatewayError('Parallel 授权有效期格式无效。', 'invalid_response');
    return now + data[name];
  };
  return { access_token: data.access_token, refresh_token: refresh, expires_at: now + data.expires_in, client_id: clientId,
    org_id: orgId, org_name: typeof data.org_name === 'string' ? data.org_name.slice(0, 200) : previous?.org_name || '',
    refresh_expires_at: expiry('refresh_token_expires_in', previous?.refresh_expires_at), authorization_expires_at: expiry('authorization_expires_in', previous?.authorization_expires_at) };
}
