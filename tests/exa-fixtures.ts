import type { HttpFetch } from '../server/providers.js';

export const EXA_SITE = 'https://dashboard.exa.ai';
export const EXA_TEAM = 'fixture-exa-team';
export const exaBareValue = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..fixture-iv.fixture-ciphertext.fixture-tag';
export const exaCookieValue = (marker = 'initial') => `next-auth.session-token=fixture-exa-session-${marker}`;
export const exaCredits = { orbCreditsInCents: 2000, orbInvoiceDebt: 0, expiringCredits: [{ balanceCents: 1000, expiresAt: '2026-10-01T07:00:00+00:00' }] };
export const exaPlan = { subscription: { plan: { external_plan_id: 'search_api_free' } } };
export const exaUpstream: HttpFetch = async (url) => {
  if (url === EXA_SITE + '/api/auth/session') return Response.json({ user: { currentTeamId: EXA_TEAM }, expires: new Date(Date.now() + 86400000).toISOString() }, { headers: { 'Set-Cookie': exaCookieValue('rotated') + '; Path=/; HttpOnly; Secure; SameSite=Lax' } });
  if (url === 'https://api.exa.ai/v0/teams/me') return Response.json({ object: 'team', id: EXA_TEAM });
  if (url === EXA_SITE + '/api/orb/get-orb-plan') return Response.json(exaPlan);
  if (url === EXA_SITE + '/api/get-credits') return Response.json(exaCredits);
  throw new Error('Unexpected Exa fixture URL');
};
