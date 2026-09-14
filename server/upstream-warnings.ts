const MAX_WARNINGS = 10;
const MAX_LENGTH = 800;

function redact(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(secret).join('[凭证已隐藏]').split(encodeURIComponent(secret)).join('[凭证已隐藏]');
  }
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, value => {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[链接已隐藏]'; }
  });
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[授权凭证已隐藏]')
    .replace(/\b(?:set-cookie|cookie)\s*[:=][^\r\n]*/gi, '[Cookie 已隐藏]')
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '[凭证已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2,4}/g, '[令牌已隐藏]')
    .replace(/\b(?:sk|tvly|keen|sa)[-_][A-Za-z0-9_-]{8,}/gi, '[密钥已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[标识已隐藏]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…（已截断）` : text;
}

export function upstreamWarnings(value: unknown, secrets: readonly string[] = []): string[] {
  if (!Array.isArray(value)) return [];
  const warnings = value.slice(0, MAX_WARNINGS).map(item => {
    if (typeof item === 'string') return `上游提示：${redact(item, secrets) || '未提供可显示的说明。'}`;
    const data = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const code = [data.code, data.type].find(v => typeof v === 'string' && v.trim());
    const message = [data.message, data.detail, data.description].find(v => typeof v === 'string' && v.trim());
    const label = typeof code === 'string' ? `（${redact(code, secrets)}）` : '';
    return `上游提示${label}：${typeof message === 'string' ? redact(message, secrets) : '未提供可显示的说明。'}`;
  });
  if (value.length > MAX_WARNINGS) warnings.push(`另有 ${value.length - MAX_WARNINGS} 项上游提示未展示。`);
  return warnings;
}

// The old adapter discarded warning bodies. Do not infer them from a later search.
export function savedWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(item => {
    const legacy = /^上游报告 (\d+) 项警告；本次检索可能受限制。$/.exec(item);
    return legacy ? `历史记录仅保存了 ${legacy[1]} 项上游警告，未保存具体原因。` : item;
  });
}
