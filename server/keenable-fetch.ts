import { GatewayError } from './upstream.js';

type Json = Record<string, unknown>;
const invalid = () => new GatewayError('Keenable 正文格式无法识别，未采纳响应内容。', 'invalid_response');

export function keenableFetchData(value: string): Json {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { /* Native MCP returns a header followed by Markdown. */ }
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    return parsed as Json;
  }
  const body = value.replace(/\r\n/g, '\n').trimStart();
  const header = /^Title: ([^\n]*)\nURL: ([^\n]+)\n\n/.exec(body);
  if (!header) throw invalid();
  return { title: header[1].trim(), url: header[2].trim(), content: body.slice(header[0].length).trim() };
}
