import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PROVIDER_LIMITS, type Provider, type SearchInput, type UsageSnapshot } from '../shared/types.js';
import type { StoredKey, Store } from './store.js';
import { KeenableBalance } from './keenable-balance.js';
import { keenableSearchData } from './keenable-search.js';
import { AnySearchBalance } from './anysearch-balance.js';
import { ExaBalance } from './exa-balance.js';
import { estimateExaCost } from './exa-ledger.js';
import { parallelFreeMcp } from './parallel-mcp.js';
import { ParallelBalance } from './parallel-balance.js';
import { boundedBody, GatewayError, responseError, type HttpFetch } from './upstream.js';
export { GatewayError, type HttpFetch } from './upstream.js';

type Json = Record<string, unknown>;
export type RawResult = { title: string; url: string; snippet: string; content?: string; published_at?: string; acquired_at?: string; truncated?: boolean };
export type ProviderData = { results: RawResult[]; warnings?: string[]; cost_usd: number | null; credits: number | null; paid?: boolean | null; usage_items?: { name: string; count: number }[]; billing_source: 'reported' | 'estimated' | 'unknown' | 'free' };
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const strings = (value: unknown): string => Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : text(value);

export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayError('请输入完整的网页 URL。', 'invalid_url', 400); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const forbidden = !['https:', 'http:'].includes(url.protocol) || !!url.username || !!url.password ||
    !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    isIP(host) !== 0 || ['localhost', 'metadata.google.internal'].includes(host);
  if (forbidden) throw new GatewayError('仅支持公网域名的 HTTP/HTTPS 网页，不支持 IP 或内网地址。', 'invalid_url', 400);
  return url;
}
export function canonicalUrl(value: string): string | null {
  try {
    const url = publicUrl(value);
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|msclkid)$/i.test(name)) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}
export class Providers {
  readonly keenableBalance: KeenableBalance;
  readonly anysearchBalance: AnySearchBalance;
  readonly exaBalance: ExaBalance;
  readonly parallelBalance: ParallelBalance;
  constructor(readonly store: Store, private http: HttpFetch = globalThis.fetch) { this.keenableBalance = new KeenableBalance(store, http); this.anysearchBalance = new AnySearchBalance(store, http); this.exaBalance = new ExaBalance(store, http); this.parallelBalance = new ParallelBalance(store, http); }
  private async request(url: string, secret: string, provider: Provider, signal: AbortSignal, body?: Json): Promise<Json> {
    try {
      const response = await this.http(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(provider === 'tavily' || provider === 'anysearch' ? { Authorization: `Bearer ${secret}` } : { 'x-api-key': secret }), ...(provider === 'anysearch' ? { 'X-Anysearch-Client': 'search-anywhere/0.2.2' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) { await response.body?.cancel(); throw responseError(response); }
      const parsed: unknown = JSON.parse(Buffer.from(await boundedBody(response)).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('schema');
      if (provider === 'anysearch') {
        if (obj(parsed).code !== 0) throw new GatewayError('AnySearch 返回业务错误，未采纳响应内容。', 'upstream_error');
        return obj(obj(parsed).data);
      }
      return obj(parsed);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (signal.aborted) throw new GatewayError('搜索超时或已取消。', 'timeout', 504);
      throw new GatewayError('上游连接失败或响应格式无效。', 'connection_error', 502, true, 10000);
    }
  }
  private normalize(provider: Provider, data: Json, mode: string, operation: string): ProviderData {
    if (!Array.isArray(data.results)) throw new GatewayError('上游结果格式无效。', 'invalid_response', 502, true);
    const warnings: string[] = [];
    const results = data.results.map(v => {
      const r = obj(v);
      const excerpt = provider === 'exa' ? strings(r.highlights) || text(r.text) || text(r.summary) :
        provider === 'parallel' ? strings(r.excerpts) || text(r.full_content) : text(r.snippet) || text(r.content) || text(r.description) || text(r.raw_content);
      const full = provider === 'exa' ? text(r.text) : provider === 'parallel' ? text(r.full_content) : text(r.raw_content) || text(r.content);
      const snippet = operation === 'fetch' ? full || excerpt : excerpt;
      return { title: text(r.title), url: text(r.url), snippet: snippet.slice(0, 100000), content: full ? full.slice(0, 100000) : undefined,
        truncated: r.truncated === true || snippet.length > 100000 || full.length > 100000 || (operation === 'fetch' && Math.max(snippet.length, full.length) >= 100000),
        acquired_at: text(r.acquired_at) || undefined,
        published_at: text(r.publishedDate) || text(r.publish_date) || text(r.published_date) || text(r.published_at) || undefined };
    }).filter(r => canonicalUrl(r.url));
    if (results.length !== data.results.length) warnings.push(`${data.results.length - results.length} 条结果缺少有效公网 URL，未纳入集合。`);
    if (results.some(r => r.truncated)) warnings.push('部分文本被上游或本地 100,000 字符存储限制截断。');
    if (Array.isArray(data.warnings) && data.warnings.length) warnings.push(`上游报告 ${data.warnings.length} 项警告；本次检索可能受限制。`);
    if (Array.isArray(data.errors) && data.errors.length) warnings.push(`上游报告 ${data.errors.length} 项提取失败。`);
    const reportedCost = num(obj(data.costDollars).total);
    const localCost = provider === 'exa' ? estimateExaCost(mode, operation, data.results.length) : null;
    const cost = reportedCost ?? localCost;
    const credits = num(obj(data.usage).credits);
    const units = Array.isArray(data.usage) ? data.usage.map(obj).filter(u => text(u.name) && num(u.count) !== null).map(u => ({ name: text(u.name).slice(0, 100), count: num(u.count)! })) : [];
    const estimate = provider === 'tavily' && operation === 'search' ? mode === 'advanced' ? 2 : 1 : null;
    return { results, warnings, cost_usd: cost, credits: credits ?? estimate, usage_items: units,
      billing_source: reportedCost !== null || credits !== null || units.length > 0 ? 'reported' : localCost !== null || estimate !== null ? 'estimated' : 'unknown' };
  }
  async search(key: StoredKey, mode: string, input: SearchInput, count: number, signal: AbortSignal): Promise<ProviderData> {
    count = Math.min(count, PROVIDER_LIMITS[key.provider]);
    if (key.provider === 'keenable') {
      const data = await this.keenable(key, 'search_web_pages', { query: input.query, max_results: count, snippet_max_length: 10000, ...(input.include_domains?.length === 1 ? { site: input.include_domains[0] } : {}) }, mode, signal);
      if (input.exclude_domains?.length || (input.include_domains?.length || 0) > 1) data.warnings!.push('此域名条件仅在网关过滤，可能减少命中数量；可按域名分别补搜。');
      return data;
    }
    const common = { include_domains: input.include_domains, exclude_domains: input.exclude_domains };
    const requests = {
      exa: { url: 'https://api.exa.ai/search', body: { query: input.query, type: mode, numResults: count, contents: { highlights: true }, includeDomains: input.include_domains, excludeDomains: input.exclude_domains } },
      parallel: { url: 'https://api.parallel.ai/v1/search', body: { objective: input.query, search_queries: [input.query.slice(0, 200)], mode,
        advanced_settings: { max_results: count, ...(input.include_domains?.length || input.exclude_domains?.length ? { source_policy: common } : {}) } } },
      tavily: { url: 'https://api.tavily.com/search', body: { query: input.query, search_depth: mode, max_results: Math.min(count, 20), include_answer: false, include_raw_content: false, include_usage: true, auto_parameters: false, ...common } },
      anysearch: { url: 'https://api.anysearch.com/v1/search', body: { query: input.query, max_results: count, format: 'json' } },
    };
    const request = requests[key.provider];
    const data = await this.request(request.url, this.store.secret(key), key.provider, signal, request.body);
    const normalized = this.normalize(key.provider, data, mode, 'search');
    if (key.provider === 'anysearch' && (input.include_domains?.length || input.exclude_domains?.length)) normalized.warnings!.push('AnySearch 域名条件仅在网关过滤，可能减少命中数量；可按域名分别补搜。');
    return normalized;
  }
  async fetch(key: StoredKey, url: string, signal: AbortSignal): Promise<ProviderData> {
    publicUrl(url);
    if (key.provider === 'keenable') return this.keenable(key, 'fetch_page_content', { url, max_chars: 100000, live: true }, 'extract', signal);
    const requests = {
      exa: { url: 'https://api.exa.ai/contents', body: { ids: [url], text: { maxCharacters: 100000 } } },
      parallel: { url: 'https://api.parallel.ai/v1/extract', body: { urls: [url], advanced_settings: { full_content: true } } },
      tavily: { url: 'https://api.tavily.com/extract', body: { urls: [url], extract_depth: 'basic', format: 'markdown', include_usage: true } },
      anysearch: { url: 'https://api.anysearch.com/v1/extract', body: { url } },
    };
    const request = requests[key.provider];
    let data = await this.request(request.url, this.store.secret(key), key.provider, signal, request.body);
    if (key.provider === 'anysearch') data = { results: [{ ...data, url: text(data.url) || url }] };
    return this.normalize(key.provider, data, 'extract', 'fetch');
  }
  async parallelFree(input: SearchInput | string, sessionId: string, signal: AbortSignal): Promise<ProviderData> {
    const fetching = typeof input === 'string';
    if (fetching) publicUrl(input);
    const args = fetching ? { urls: [input], full_content: true, session_id: sessionId } :
      { objective: input.query, search_queries: [input.query.slice(0, 200)], session_id: sessionId };
    const response = await parallelFreeMcp(this.http, fetching ? 'web_fetch' : 'web_search', args, signal);
    const data = this.normalize('parallel', response, fetching ? 'extract' : 'fast', fetching ? 'fetch' : 'search');
    data.warnings!.push(fetching ? '已请求完整正文；实际返回受上游抓取能力及本地 100,000 字符 / 4 MB 限制。' :
      '免费 MCP 固定 fast，返回条数由上游决定；单次摘录合计约限 25,000 字符。可用 fetch 读取命中网页正文，并补搜遗漏。');
    if (!fetching && (input.include_domains?.length || input.exclude_domains?.length)) data.warnings!.push('免费 MCP 的域名条件仅在网关过滤，可能减少命中数量；可按域名分别补搜或选择 API 直连。');
    return { ...data, cost_usd: 0, credits: null, paid: false, usage_items: [], billing_source: 'free' };
  }
  private async keenable(key: StoredKey, name: string, args: Json, mode: string, signal: AbortSignal): Promise<ProviderData> {
    const client = new Client({ name: 'search-anywhere', version: '0.2.2' });
    let httpError: GatewayError | undefined;
    const transport = new StreamableHTTPClientTransport(new URL('https://api.keenable.ai/mcp'), {
      requestInit: { headers: { 'X-API-Key': this.store.secret(key) } },
      fetch: async (input, init) => {
        const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        const response = await this.http(String(input), { ...init, signal: combined, redirect: 'error' });
        if (init?.method === 'GET') return response;
        if (!response.ok) { await response.body?.cancel(); httpError = responseError(response); throw httpError; }
        // The optional GET stream must stay streaming; tool POST responses are finite.
        if (init?.method === 'GET' || response.status === 202 || response.status === 204) return response;
        const body = await boundedBody(response).catch(error => { if (error instanceof GatewayError) httpError = error; throw error; });
        return new Response(body as BodyInit, { status: response.status, headers: response.headers });
      },
    });
    try {
      await client.connect(transport, { signal, timeout: 180000 });
      const response = await client.callTool({ name, arguments: args, _meta: { 'keenable/overrides': { ...(mode === 'extract' ? {} : { mode }), skip_cache: true } } }, undefined, { signal, timeout: 180000 });
      if (response.isError) throw new GatewayError('Keenable 工具返回错误，未采纳响应内容。', 'upstream_error');
      const blocks = Array.isArray(response.content) ? response.content.map(obj).filter(c => c.type === 'text').map(c => text(c.text)) : [];
      const data = obj(response.structuredContent || (mode === 'extract' ? JSON.parse(blocks.join('\n')) : keenableSearchData(blocks.join('\n'))));
      const normalized = this.normalize('keenable', mode === 'extract' ? { results: [{ ...data, url: text(data.url) || args.url }] } : data, mode, mode === 'extract' ? 'fetch' : 'search');
      const usage = obj(obj(response._meta)['keenable/usage']);
      return { ...normalized, credits: num(usage.credits), paid: typeof usage.paid === 'boolean' ? usage.paid : null,
        usage_items: text(usage.sku) && num(usage.amount) !== null ? [{ name: text(usage.sku).slice(0, 100), count: num(usage.amount)! }] : [],
        billing_source: num(usage.credits) !== null ? 'reported' : 'unknown' };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (signal.aborted) throw new GatewayError('搜索超时或已取消。', 'timeout', 504);
      if (httpError) throw httpError;
      throw new GatewayError('Keenable 连接失败或未返回结构化结果。', 'invalid_response');
    } finally { await client.close().catch(() => undefined); }
  }
  async usage(key: StoredKey): Promise<UsageSnapshot> {
    const synced_at = new Date().toISOString();
    if (key.provider === 'keenable') return this.keenableBalance.usage(key);
    if (key.provider === 'anysearch') return this.anysearchBalance.usage(key);
    if (key.provider === 'parallel') return this.parallelBalance.usage(key);
    if (key.provider === 'exa') {
      const manual = this.store.exaLedger.manualUsage(key.id);
      if (manual) return manual;
      if (this.store.loginSession(key.id)) return this.exaBalance.usage(key);
      const service = this.store.managementSecret(key.account);
      if (!service || !key.exa_key_id) return { status: 'needs_setup', source: 'unknown', synced_at, message: '配置 Exa 官网会话 Cookie 与 Team ID 可查询余额；或配置 Service Key 和搜索 key ID，查询本月已用费用。' };
      const start = `${synced_at.slice(0, 7)}-01`;
      const data = await this.request(`https://admin-api.exa.ai/team-management/api-keys/${encodeURIComponent(key.exa_key_id)}/usage?start_date=${start}`, service, 'exa', AbortSignal.timeout(15000));
      const cost = num(data.total_cost_usd);
      if (cost === null) throw new GatewayError('Exa 用量响应缺少有效费用。', 'invalid_response');
      return { status: 'ok', source: 'official', synced_at, period: start, cost_usd: cost, message: '本月已用费用，不代表账户现金余额。' };
    }
    const data = await this.request('https://api.tavily.com/usage', this.store.secret(key), key.provider, AbortSignal.timeout(15000));
    const k = obj(data.key), a = obj(data.account);
    if (num(k.usage) === null || num(a.plan_usage) === null || num(a.plan_limit) === null) throw new GatewayError('Tavily 用量响应缺少额度字段。', 'invalid_response');
    return { status: 'ok', source: 'official', synced_at, key: { used: num(k.usage)!, limit: num(k.limit) },
      account: { plan: text(a.current_plan), used: num(a.plan_usage)!, limit: num(a.plan_limit)!, paygo_used: num(a.paygo_usage) ?? 0, paygo_limit: num(a.paygo_limit) } };
  }
}
