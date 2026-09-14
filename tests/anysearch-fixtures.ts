import type { HttpFetch } from '../server/providers.js';
import type { LoginTokens } from '../server/store.js';

export const ANY_BASE = 'https://www.anysearch.com';
export function anyTokens(seconds = 1800, marker = 'initial'): LoginTokens {
  const expires_at = Math.floor(Date.now() / 1000) + seconds;
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.anysearch.com', product_line: 'anysearch', exp: expires_at, marker })).toString('base64url');
  return { access_token: `eyJhbGciOiJFZERTQSJ9.${payload}.fixture-signature`, refresh_token: `fixture-any-refresh-${marker}`, expires_at };
}
export const anyQuota = { tier_code: 'basic', tier_name: 'Free', total: 1000, used: 5, remaining: 993, reset_period: 'daily', next_reset_at: '2026-10-01T00:00:00Z', usage_stats_available: true, total_calls: 10, current_month_calls: 5 };
export const envelope = (data: unknown, code = 0) => Response.json({ code, data });
export function anyUpstream(keys = ['anysearch-secret-0123456789']): HttpFetch {
  return async url => {
    if (url === ANY_BASE + '/api/auth/refresh') return envelope({ ...anyTokens(1800, 'rotated'), expires_in_seconds: 1800 });
    if (url === ANY_BASE + '/api/auth/me') return envelope({ logged_in: true, user: { auth_user_id: 'fixture-any-account' } });
    if (url === ANY_BASE + '/api/user/keys') return envelope({ keys: keys.map(key => ({ key, quota_used: 5, quota_limit: 0, quota_is_unlimited: true })) });
    if (url === ANY_BASE + '/api/user/billing/overview') return envelope(anyQuota);
    throw new Error('Unexpected fixture URL');
  };
}
