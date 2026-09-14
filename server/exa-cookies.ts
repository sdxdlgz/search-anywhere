import { GatewayError } from './upstream.js';

const cookieName = /^(?:__Secure-)?next-auth\.session-token(?:\.(0|[1-9]\d?))?$/;
const sessionValue = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const invalid = () => new GatewayError('请粘贴完整的 Exa 会话值，或按“名称=值”填写 Cookie；分片需带名称、从 .0 起连续提供，且不能混用两种 Cookie 名称。', 'invalid_login', 400);

function serialize(values: Map<string, string>): string {
  const names = [...values.keys()];
  if (!names.length || names.length > 16) throw invalid();
  const base = names[0].replace(/\.\d+$/, '');
  if (names.some(name => name.replace(/\.\d+$/, '') !== base)) throw invalid();
  const ordered = names.length === 1 && names[0] === base ? names : names.sort((a, b) => Number(a.split('.').at(-1)) - Number(b.split('.').at(-1)));
  if (ordered[0] !== base && ordered.some((name, index) => name !== `${base}.${index}`)) throw invalid();
  if (ordered.includes(base) && ordered.length !== 1) throw invalid();
  const result = ordered.map(name => `${name}=${values.get(name)}`).join('; ');
  if (result.length > 32768 || [...values.values()].some(value => value.length < 1 || !/^[A-Za-z0-9._~%+=/-]+$/.test(value))) throw invalid();
  if ([...values.values()].join('').length < 8) throw invalid();
  return result;
}

export function exaCookie(input: string): string {
  if (input.length > 32768 || /[\r\n\x00]/.test(input)) throw invalid();
  const trimmed = input.trim();
  if (sessionValue.test(trimmed)) return serialize(new Map([['next-auth.session-token', trimmed]]));
  const values = new Map<string, string>();
  for (const entry of trimmed.replace(/^Cookie:\s*/i, '').split(';')) {
    const split = entry.indexOf('=');
    const name = entry.slice(0, split).trim();
    if (split < 0 || !cookieName.test(name)) continue;
    if (values.has(name)) throw invalid();
    values.set(name, entry.slice(split + 1).trim());
  }
  return serialize(values);
}

export function updatedExaCookie(current: string, headers: Headers): { cookie: string; changed: boolean } {
  const values = new Map(current.split('; ').map(entry => { const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)]; }));
  let changed = false;
  for (const header of headers.getSetCookie()) {
    const [entry, ...attributes] = header.split(';');
    const split = entry.indexOf('='), name = entry.slice(0, split).trim();
    if (split < 0 || !cookieName.test(name)) continue;
    changed = true;
    const value = entry.slice(split + 1).trim();
    const maxAge = attributes.find(a => /^\s*max-age=/i.test(a))?.split('=')[1];
    const expiryAttribute = attributes.find(a => /^\s*expires=/i.test(a));
    const expires = expiryAttribute?.slice(expiryAttribute.indexOf('=') + 1);
    const deleted = maxAge !== undefined ? Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now();
    if (!value || deleted) values.delete(name); else values.set(name, value);
  }
  if (!changed) return { cookie: current, changed: false };
  if (!values.size) throw new GatewayError('Exa 官网已清除登录会话，请重新配置 Cookie。', 'exa_login_expired', 401);
  try { return { cookie: serialize(values), changed: true }; }
  catch { throw new GatewayError('Exa 返回的会话 Cookie 分片不完整，请重新配置。', 'exa_cookie_invalid', 502); }
}
