import { GatewayError } from './upstream.js';

type Json = Record<string, unknown>;
const invalid = () => new GatewayError('Keenable 搜索结果格式无法识别，未采纳响应内容。', 'invalid_response', 502);

// MCP may return formatted text without structuredContent, even for a successful search.
export function keenableSearchData(value: string): Json {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { /* Try the native MCP text format below. */ }
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    return parsed as Json;
  }
  const body = value.replace(/\r\n/g, '\n').trim();
  const header = /^Title: ([^\n]*)\nURL: ([^\n]+)\n(?:Published: ([^\n]*)\n)?(?:Acquired: ([^\n]*)\n)?Snippets:(?:\n|$)/gm;
  const entries = [...body.matchAll(header)];
  if (!entries.length || body.slice(0, entries[0].index).trim()) throw invalid();
  const results = entries.map((entry, index) => ({
    title: entry[1].trim(), url: entry[2].trim(),
    published_at: entry[3]?.trim() || undefined, acquired_at: entry[4]?.trim() || undefined,
    snippet: body.slice(entry.index! + entry[0].length, entries[index + 1]?.index ?? body.length).trim(),
  }));
  return { results };
}
