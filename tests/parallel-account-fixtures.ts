import type { ParallelTokens } from '../server/store.js';
import type { HttpFetch } from '../server/providers.js';
import { PARALLEL_BALANCE, PARALLEL_PLATFORM } from '../server/parallel-account.js';
import { upstream } from './helpers.js';

export { PARALLEL_BALANCE, PARALLEL_PLATFORM };
export const tokenResponse = (extra: Record<string, unknown> = {}) => ({ access_token: 'parallel-access-rotated-12345678', refresh_token: 'parallel-refresh-rotated-12345678', expires_in: 3600, token_type: 'Bearer', org_id: 'org-fixture', org_name: 'Fixture Org', scope: 'balance:read', refresh_token_expires_in: 86400, authorization_expires_in: 86400, ...extra });
export const savedTokens = (extra: Partial<ParallelTokens> = {}): ParallelTokens => ({ access_token: 'parallel-access-saved-12345678', refresh_token: 'parallel-refresh-saved-12345678', expires_at: Date.now() / 1000 + 3600, client_id: 'fixture-client', org_id: 'org-fixture', org_name: 'Fixture Org', ...extra });
export const balanceResponse = (extra: Record<string, unknown> = {}) => ({ org_id: 'org-fixture', credit_balance_cents: 2000, pending_debit_balance_cents: 125.5, will_invoice: false, ...extra });
export const deviceResponse = (extra: Record<string, unknown> = {}) => ({ device_code: 'private-device-code-12345678', user_code: 'TEST-CODE', verification_uri: `${PARALLEL_PLATFORM}/getServiceKeys/device`, verification_uri_complete: `${PARALLEL_PLATFORM}/getServiceKeys/device?user_code=TEST-CODE`, expires_in: 600, interval: 1, ...extra });
export const accountMock: HttpFetch = async (url, init) => {
  if (url.endsWith('/getServiceKeys/register')) return Response.json({ client_id: 'fixture-client' });
  if (url.endsWith('/getServiceKeys/device/code')) return Response.json(deviceResponse());
  if (url.endsWith('/getServiceKeys/token')) return Response.json(tokenResponse());
  if (url === PARALLEL_BALANCE) return Response.json(balanceResponse());
  return upstream(url, init);
};
