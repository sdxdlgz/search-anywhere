import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { type HttpFetch } from '../server/providers.js';
import type { Profile, Provider } from '../shared/types.js';

export const ADMIN = 'admin-test-credential-only-123456';
export const result = (provider: string, url = `https://${provider}.example.com/article`) => ({ title: `${provider} result`, url, content: 'A useful excerpt', highlights: ['A useful excerpt'], excerpts: ['A useful excerpt'], full_content: 'Full page text', text: 'Full page text' });
export const LEGACY_PROVIDERS = ['exa', 'parallel', 'tavily'] as const;
export const upstream: HttpFetch = async (url, init) => {
  if (url.includes('keenable')) {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init?.body));
    if (!('id' in rpc)) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-keenable', version: '1' } } });
    const data = rpc.params.name === 'fetch_page_content' ? { ...result('keenable', rpc.params.arguments.url), content: 'Full page text' } : { results: [{ ...result('keenable'), snippet: 'Keenable excerpt' }] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], _meta: { 'keenable/usage': { sku: 'search.pro', amount: 1, credits: 3, paid: false } } } });
  }
  if (url.includes('anysearch')) return Response.json({ code: 0, message: 'success', data: url.endsWith('/extract') ? { ...result('anysearch', JSON.parse(String(init?.body)).url), truncated: false } : { results: [result('anysearch')] } });
  if (url.endsWith('/usage')) return Response.json({ key: { usage: 20, limit: 100 }, account: { current_plan: 'Free', plan_usage: 25, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } });
  const provider = url.includes('tavily') ? 'tavily' : url.includes('parallel') ? 'parallel' : 'exa';
  return Response.json({ results: [result(provider)], ...(provider === 'exa' ? { costDollars: { total: .007 } } : provider === 'tavily' ? { usage: { credits: 1 } } : {}) });
};
export function fixture(http: HttpFetch = upstream, defaultProfile = 'balanced', parallelTransport: Profile['parallel_transport'] = 'api') {
  const directory = mkdtempSync(join(tmpdir(), 'search-anywhere-test-'));
  const runtime = createApp({ directory, adminToken: ADMIN, fetch: http });
  // R-series scenarios exercise keyed providers; P-series explicitly exercise free-first/default routing.
  for (const profile of runtime.store.profiles()) runtime.store.saveProfile({ ...profile, parallel_transport: parallelTransport });
  // Existing R-series scenarios verify the legacy three-provider preset contract.
  if (defaultProfile !== 'coverage') runtime.store.saveSettings({ ...runtime.store.settings(), default_profile: defaultProfile });
  let server: Server | undefined;
  return { ...runtime, directory,
    add(provider: Provider, account = 'owner@example.com', keys = [`${provider}-secret-0123456789`]) {
      return runtime.store.createKeys({ provider, account, label: `${provider} key`, keys, max_concurrency: 2 });
    },
    async listen() { server = runtime.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    async cleanup() {
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      runtime.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('search-anywhere-test-')) throw new Error('Unsafe cleanup path');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export async function login(base: string) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ADMIN }) });
  return response.headers.get('set-cookie')!.split(';')[0];
}
export const caller = { id: 'test', name: 'test harness' };
