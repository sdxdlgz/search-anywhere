import type { KeenableTokens } from '../server/store.js';
import type { HttpFetch } from '../server/providers.js';

export const AUTH = 'https://caqmfcgrdovyjdhfnwzw.supabase.co/auth/v1';
export function tokens(seconds = 3600, marker = 'fixture'): KeenableTokens {
  const expires_at = Math.floor(Date.now() / 1000) + seconds;
  const body = Buffer.from(JSON.stringify({ iss: AUTH, exp: expires_at, sub: 'fixture-user', marker })).toString('base64url');
  return { access_token: `eyJhbGciOiJIUzI1NiJ9.${body}.fixture-signature`, refresh_token: `fixture-refresh-${marker}`, expires_at };
}
export const balance = { org_id: 'fixture-org', free_credits: 100000, paid_credits: 25, charged_spendings: 12 };
export const keenableUpstream: HttpFetch = async (url) => {
  if (url.endsWith('/v1/auth/user')) return Response.json({ org_id: 'fixture-org' });
  if (url.includes('grant_type=refresh_token')) return Response.json(tokens(3600, 'rotated'));
  if (url.endsWith('/organization/balance')) return Response.json(balance);
  throw new Error('Unexpected fixture URL');
};
