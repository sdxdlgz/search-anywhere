import express from 'express';
import { resolve } from 'node:path';
import { fixture, upstream } from './helpers.js';
import { AUTH, keenableUpstream } from './keenable-fixtures.js';
import { ANY_BASE, anyUpstream } from './anysearch-fixtures.js';
import { EXA_SITE, exaUpstream } from './exa-fixtures.js';
import { FREE_MCP, mcpResult, parallelMock } from './parallel-fixtures.js';
import { PARALLEL_BALANCE, PARALLEL_PLATFORM, accountMock } from './parallel-account-fixtures.js';
import { result } from './helpers.js';

// Isolated mock upstream. Never reads production data or real provider credentials.
const anysearch = anyUpstream(['anysearch-browser-secret-12345678']);
let authorizations = 0;
const freeParallel = parallelMock(rpc => {
  if (String(rpc.params?.arguments.objective).includes('parallel-rate-limit-browser')) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  const url = (rpc.params?.arguments.urls as string[] | undefined)?.[0];
  return mcpResult(rpc, { results: [{ ...result('parallel', url), full_content: url ? 'Parallel full page evidence. '.repeat(1800) : undefined }] });
});
const f = fixture(async (url, init) => {
  if (url === FREE_MCP) return freeParallel(url, init);
  if (url.startsWith(`${PARALLEL_PLATFORM}/getServiceKeys/`) || url === PARALLEL_BALANCE) {
    if (url.endsWith('/device/code')) authorizations++;
    if (url.endsWith('/token') && authorizations === 1) return Response.json({ error: 'access_denied' }, { status: 400 });
    return accountMock(url, init);
  }
  if (url === EXA_SITE + '/api/auth/session' && new Headers(init?.headers).get('Cookie')?.includes('fixture-browser-challenge')) return new Response('Vercel Security Checkpoint', { status: 429, headers: { 'x-vercel-mitigated': 'challenge', 'Content-Type': 'text/html' } });
  if (url === EXA_SITE + '/api/auth/session' && new Headers(init?.headers).get('Cookie')?.includes('fixture-browser-expired')) return Response.json({});
  if (url.startsWith(EXA_SITE + '/api/') || url === 'https://api.exa.ai/v0/teams/me') return exaUpstream(url, init);
  if (url === `${ANY_BASE}/api/auth/refresh` && JSON.parse(String(init?.body)).refresh_token === 'fixture-any-invalid-login') return Response.json({ code: 40141 }, { status: 401 });
  if (url.startsWith(`${ANY_BASE}/api/`)) return anysearch(url, init);
  if (url.startsWith(AUTH) && JSON.parse(String(init?.body)).refresh_token === 'fixture-invalid-login') return Response.json({ error: 'invalid_grant' }, { status: 400 });
  if (url.startsWith(AUTH) || url.endsWith('/v1/auth/user') || url.endsWith('/organization/balance')) return keenableUpstream(url, init);
  if (url.endsWith('/usage')) return Response.json({ key: { usage: 0, limit: null }, account: { current_plan: 'Researcher', plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
  if (url === 'https://api.parallel.ai/v1/search' && String(init?.body).includes('parallel-warning-browser')) return Response.json({
    results: [result('parallel')], warnings: [
      { type: 'input_validation_warning', message: 'Reducing max_results=40 to 20.' },
      { type: 'input_validation_warning', message: 'Neither objective nor search_queries were provided, provide at least one to increase the relevance of excerpts.' },
      { code: 'display_test', message: `Credential ${new Headers(init?.headers).get('x-api-key')}; <img src=x onerror=window.warningInjected=true>` },
    ],
  });
  const response = await upstream(url, init);
  const request = init?.body ? JSON.parse(String(init.body)) : {};
  const search = url.endsWith('/search') || request.params?.name === 'search_web_pages';
  if (!search) return response;
  const envelope = await response.json();
  const data = url.includes('keenable') ? JSON.parse(envelope.result.content[0].text) : envelope.data || envelope;
  const original = data.results[0];
  data.results = [{ ...original, url: 'https://shared.example.com/article', snippet: 'A retained excerpt', text: 'Retained full evidence. '.repeat(1000), content: 'Retained full evidence. '.repeat(1000) }, ...Array.from({ length: 12 }, (_, i) => ({ ...original, url: `${original.url}/${i}` }))];
  if (url.includes('keenable')) envelope.result.content[0].text = JSON.stringify(data);
  return Response.json(envelope);
}, 'coverage');
f.app.use(express.static(resolve('dist')));
f.app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = f.app.listen(8876, '127.0.0.1', () => console.log('Browser fixture ready on 8876'));
const stop = () => server.close(() => { void f.cleanup().then(() => process.exit(0)); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
