import type { Store } from './store.js';
import type { Provider, TokenUsage, TokenUsagePeriod } from '../shared/types.js';

// Names are mutable and non-unique. Only the saved collection owner can recover a legacy ID.
export function backfillRequestCallers(store: Store) {
  store.run(`UPDATE requests SET caller_id=(SELECT caller_id FROM collections WHERE collections.id=requests.id)
    WHERE caller_id IS NULL AND EXISTS (SELECT 1 FROM collections WHERE collections.id=requests.id)`);
}

const emptyPeriod = (): TokenUsagePeriod => ({ requests: 0, cache_hits: 0, errors: 0, partial: 0, running: 0,
  upstream_calls: 0, free_calls: 0, unpriced_calls: 0, running_calls: 0,
  reported_cost_usd: null, estimated_cost_usd: null, credits_by_provider: [] });
type RequestTotals = Pick<TokenUsagePeriod, 'requests' | 'cache_hits' | 'errors' | 'partial' | 'running'> & { caller_id: string };
type CallTotals = Omit<TokenUsagePeriod, keyof RequestTotals | 'credits_by_provider'> & {
  caller_id: string; provider: Provider; reported_credits: number | null; estimated_credits: number | null;
};
const addKnown = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);

function periodTotals(store: Store, since: string, until: string): Map<string, TokenUsagePeriod> {
  const totals = new Map<string, TokenUsagePeriod>();
  const get = (id: string) => { if (!totals.has(id)) totals.set(id, emptyPeriod()); return totals.get(id)!; };
  // Aggregate requests separately: a retry or multiple providers must not multiply request counts.
  const requests = store.all<RequestTotals>(`SELECT r.caller_id,COUNT(*) requests,SUM(r.cache_hit) cache_hits,
    SUM(r.status='error') errors,SUM(r.status='partial') partial,SUM(r.status='running') running
    FROM requests r JOIN client_tokens t ON t.id=r.caller_id WHERE r.created_at>=? AND r.created_at<? GROUP BY r.caller_id`, since, until);
  for (const { caller_id, ...counts } of requests) Object.assign(get(caller_id), counts);
  const calls = store.all<CallTotals>(`SELECT r.caller_id,c.provider,COUNT(*) upstream_calls,
    SUM(c.billing_source='free') free_calls,SUM(c.status='running') running_calls,
    SUM(c.status!='running' AND COALESCE(c.billing_source,'unknown')!='free'
      AND NOT (COALESCE(c.billing_source,'unknown') IN ('reported','estimated') AND (c.cost_usd IS NOT NULL OR c.credits IS NOT NULL))) unpriced_calls,
    SUM(CASE WHEN c.billing_source='reported' THEN c.cost_usd END) reported_cost_usd,
    SUM(CASE WHEN c.billing_source='estimated' THEN c.cost_usd END) estimated_cost_usd,
    SUM(CASE WHEN c.billing_source='reported' THEN c.credits END) reported_credits,
    SUM(CASE WHEN c.billing_source='estimated' THEN c.credits END) estimated_credits
    FROM calls c JOIN requests r ON r.id=c.request_id JOIN client_tokens t ON t.id=r.caller_id
    WHERE c.created_at>=? AND c.created_at<? GROUP BY r.caller_id,c.provider`, since, until);
  for (const row of calls) {
    const value = get(row.caller_id);
    for (const key of ['upstream_calls', 'free_calls', 'unpriced_calls', 'running_calls'] as const) value[key] += row[key];
    value.reported_cost_usd = addKnown(value.reported_cost_usd, row.reported_cost_usd);
    value.estimated_cost_usd = addKnown(value.estimated_cost_usd, row.estimated_cost_usd);
    if (row.reported_credits !== null || row.estimated_credits !== null) value.credits_by_provider.push({ provider: row.provider, reported: row.reported_credits, estimated: row.estimated_credits });
  }
  return totals;
}

export function tokenUsage(store: Store, at = new Date()): Map<string, TokenUsage> {
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
  const monthEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
  const lifetime = periodTotals(store, '', '9999'), month = periodTotals(store, monthStart, monthEnd);
  return new Map(store.all<{ id: string }>('SELECT id FROM client_tokens').map(({ id }) => [id,
    { lifetime: lifetime.get(id) ?? emptyPeriod(), month: month.get(id) ?? emptyPeriod(), month_start: monthStart }]));
}
