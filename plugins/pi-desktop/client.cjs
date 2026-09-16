const { URL } = require('node:url');

class SearchError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

function gatewayUrl(value, domains) {
  let url;
  try { url = new URL(value); } catch { throw new SearchError('configuration', '请填写完整的网关地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SearchError('configuration', '远程网关必须使用 HTTPS；本机地址可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SearchError('configuration', '网关地址不能包含凭证、查询参数或片段。');
  }
  if (!domains.includes(url.hostname)) throw new SearchError('configuration', '此域名未在安装包中授权，请为该网关重新打包插件。');
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(mcp|v1(?:\/.*)?)$/.test(path)) throw new SearchError('configuration', '请填写网关根地址，不要附加 /mcp 或 /v1。');
  return url.origin + path;
}

async function bodyText(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new SearchError('response_too_large', '网关响应过大，请减少每页数量后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new SearchError('response_too_large', '网关响应过大，请减少每页数量后重试。');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function request(config, endpoint, args, signal, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? config.timeoutSeconds * 1000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetchImpl(`${config.gateway}${endpoint}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args), redirect: 'manual', signal: combined,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SearchError('redirect_refused', '网关返回了重定向；请配置最终 HTTPS 根地址。', response.status);
    }
    const text = await bodyText(response, options.maxBytes ?? 4 * 1024 * 1024);
    let value;
    try { value = JSON.parse(text); } catch { throw new SearchError('invalid_response', '网关返回了非 JSON 响应，请检查地址或反向代理。', response.status); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SearchError('invalid_response', '网关响应格式不正确。', response.status);
    if (!response.ok) {
      const code = typeof value.error?.code === 'string' ? value.error.code.slice(0, 80) : 'http_error';
      const message = typeof value.error?.message === 'string' ? value.error.message.slice(0, 1000) : `网关请求失败（HTTP ${response.status}）。`;
      throw new SearchError(code.replaceAll(config.token, '[redacted]'), message.replaceAll(config.token, '[redacted]'), response.status);
    }
    return value;
  } catch (error) {
    if (signal?.aborted) throw new SearchError('cancelled', '搜索任务已取消。');
    if (deadline.aborted) throw new SearchError('timeout', '已超过插件总等待时间，请检查网关日志。');
    if (error instanceof SearchError) throw error;
    throw new SearchError('network_error', '无法连接搜索网关，请检查网络和网关地址。');
  }
}

module.exports = { SearchError, gatewayUrl, request };
