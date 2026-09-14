export class GatewayError extends Error {
  constructor(message: string, readonly code: string, readonly status = 502, readonly retryable = false, readonly cooldownMs = 0) { super(message); }
}

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function responseError(response: Response): GatewayError {
  const status = response.status;
  if (status === 401) return new GatewayError('上游密钥无效，请检查凭证。', 'invalid_key', status);
  if (status === 402) return new GatewayError('上游账户额度不足。', 'exhausted', status, true, 300000);
  if (status === 403) return new GatewayError('上游拒绝访问，请检查权限。', 'forbidden', status, true, 60000);
  if (status === 429) {
    const after = response.headers.get('retry-after') || '';
    const parsed = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
    return new GatewayError('上游限流，密钥已进入冷却。', 'rate_limited', status, true, Math.min(3600000, Math.max(1000, Number.isFinite(parsed) ? parsed : 60000)));
  }
  return new GatewayError(status >= 500 ? '上游服务暂时不可用。' : '上游拒绝了搜索参数。', status >= 500 ? 'upstream_error' : 'upstream_validation', status, status >= 500, status >= 500 ? 30000 : 0);
}

export async function boundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 4000000) { await reader.cancel(); throw new GatewayError('上游响应超过 4 MB 限制；该渠道结果未收集。', 'response_too_large'); }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}
