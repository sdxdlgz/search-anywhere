import type { HttpFetch } from '../server/providers.js';
import { result, upstream } from './helpers.js';

export const FREE_MCP = 'https://search.parallel.ai/mcp';
export type Rpc = { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
export function mcpResult(rpc: Rpc, data: unknown, options: { text?: boolean; sse?: boolean; isError?: boolean } = {}) {
  const reply = { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], ...(options.text ? {} : { structuredContent: data }), isError: !!options.isError } };
  return options.sse ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(reply);
}
export function parallelMock(tool?: (rpc: Rpc, init?: RequestInit) => Response | Promise<Response>): HttpFetch {
  return async (url, init) => {
    if (url !== FREE_MCP) return upstream(url, init);
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const rpc: Rpc = JSON.parse(String(init?.body));
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-parallel', version: '1' } } });
    if (tool) return tool(rpc, init);
    const urlToFetch = (rpc.params?.arguments.urls as string[] | undefined)?.[0];
    return mcpResult(rpc, { results: [result('parallel', urlToFetch)], warnings: [] });
  };
}
