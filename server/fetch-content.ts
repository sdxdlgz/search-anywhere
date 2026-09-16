import type { Provider } from '../shared/types.js';
import type { ProviderData, RawResult } from './providers.js';
import { GatewayError } from './upstream.js';

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const list = (v: unknown): Json[] => Array.isArray(v) ? v.map(object) : [];

// Match short interstitial templates, not articles merely discussing bot protection.
export function blockedPage(result: RawResult): boolean {
  const text = (result.content || result.snippet).trim();
  if (text.length > 3000) return false;
  const start = text.replace(/^[\s#*]+/, '');
  return /^You've been blocked by network security\./i.test(start) ||
    /^(?:Just a moment|Attention Required)[.!…\s|-]/i.test(result.title) && /(?:verify you are human|checking your browser|enable javascript and cookies|cloudflare)/i.test(text) ||
    /^(?:火山引擎\s*)?正在进行安全检测/.test(start);
}

export function requirePage(data: ProviderData, provider?: Provider, raw: Json = {}): ProviderData {
  const nonempty = data.results.filter(r => r.snippet.trim());
  const results = nonempty.filter(r => !blockedPage(r));
  const blocked = nonempty.length - results.length;
  if (results.length) return { ...data, results, warnings: [...(data.warnings || []), ...(blocked ? [`${blocked} 条安全验证 / 拦截页未纳入正文证据。`] : [])] };
  const { results: _results, ...usage } = data;
  if (blocked) throw new GatewayError('上游返回了目标网站的安全验证 / 拦截页，未作为正文保存；请使用其他来源或搜索摘录。', 'source_blocked', 502, false, 0, usage);
  let detail = '';
  if (provider === 'exa') {
    const failed = list(raw.statuses).find(s => s.status === 'error');
    if (failed) {
      const status = object(failed.error).httpStatusCode;
      const http = Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? `（源站 HTTP ${status}）` : '';
      detail = `Exa 无法读取目标网页${http}；可使用其他来源或搜索摘录。`;
    }
  }
  if (provider === 'tavily' && list(raw.failed_results).length) detail = 'Tavily 无法提取目标网页；可使用其他来源或搜索摘录。';
  if (provider === 'parallel' && list(raw.errors).length) detail = 'Parallel 无法提取目标网页；可使用其他来源或搜索摘录。';
  throw new GatewayError(detail || '上游未返回网页正文；目标页面可能不可访问或不支持提取。', detail ? 'source_unavailable' : 'empty_content', 502, false, 0, usage);
}
