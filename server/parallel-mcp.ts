import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boundedBody, GatewayError, responseError, type HttpFetch } from './upstream.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};

export async function parallelFreeMcp(http: HttpFetch, name: string, args: Json, signal: AbortSignal): Promise<Json> {
  const client = new Client({ name: 'search-anywhere', version: '0.2.2' });
  let transportError: GatewayError | undefined;
  const transport = new StreamableHTTPClientTransport(new URL('https://search.parallel.ai/mcp'), {
    fetch: async (input, init) => {
      const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      const response = await http(String(input), { ...init, signal: combined, redirect: 'error' });
      // GET is an optional server stream; its 405 response is normal.
      if (init?.method === 'GET') return response;
      if (!response.ok) {
        await response.body?.cancel();
        const error = responseError(response);
        transportError = new GatewayError('Parallel 免费 MCP 请求失败。', error.code, error.status, false, error.cooldownMs);
        throw transportError;
      }
      if (response.status === 202 || response.status === 204) return response;
      const body = await boundedBody(response).catch(error => { if (error instanceof GatewayError) transportError = error; throw error; });
      return new Response(body as BodyInit, { status: response.status, headers: response.headers });
    },
  });
  try {
    await client.connect(transport, { signal, timeout: 180000 });
    const response = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 180000 });
    const blocks = Array.isArray(response.content) ? response.content.map(object).filter(c => c.type === 'text' && typeof c.text === 'string') : [];
    let data = object(response.structuredContent);
    if (!response.structuredContent && blocks.length) {
      try { data = object(JSON.parse(blocks.map(c => c.text).join('\n'))); } catch { /* Plain tool errors carry no trusted status code. */ }
    }
    if (response.isError) {
      const error = object(data.error);
      const limited = [data, error].some(e => e.status === 429 || e.http_status === 429 || e.code === 'rate_limited');
      throw new GatewayError(limited ? 'Parallel 免费 MCP 已限流。' : 'Parallel 免费 MCP 工具返回错误。', limited ? 'rate_limited' : 'upstream_error', limited ? 429 : 502, false, limited ? 60000 : 0);
    }
    if (!Array.isArray(data.results)) throw new GatewayError('Parallel 免费 MCP 未返回有效结构化结果。', 'invalid_response');
    return data;
  } catch (error) {
    if (signal.aborted) throw new GatewayError('搜索超时或已取消。', 'timeout', 504);
    if (transportError) throw transportError;
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('Parallel 免费 MCP 连接失败或响应格式无效。', 'connection_error');
  } finally { await client.close().catch(() => undefined); }
}
