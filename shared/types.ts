export const PROVIDERS = ['exa', 'parallel', 'tavily', 'anysearch', 'keenable'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type SearchTransport = 'api' | 'free_mcp';
export type RouteInfo = { transport?: SearchTransport; fallback_reason?: 'free_rate_limited' | null };
export const MODES: Record<Provider, string[]> = {
  exa: ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'],
  parallel: ['turbo', 'fast', 'basic', 'advanced'],
  tavily: ['ultra-fast', 'fast', 'basic', 'advanced'],
  anysearch: ['auto'],
  keenable: ['realtime', 'pro'],
};
export const PROVIDER_LIMITS: Record<Provider, number> = { exa: 100, parallel: 40, tavily: 20, anysearch: 20, keenable: 50 };
export type Profile = {
  id: string; name: string; modes: Partial<Record<Provider, string | null>>;
  max_results: number; timeout_ms: number; cache_ttl_seconds: number; version: number;
  per_provider_results?: number; fetch_strategy?: 'fallback' | 'parallel'; parallel_transport?: 'free_first' | 'api';
};
export type UsageSnapshot = {
  status: 'ok' | 'needs_setup' | 'unsupported'; source: 'official' | 'unknown';
  synced_at: string; message?: string; period?: string;
  key?: { used: number; limit: number | null };
  account?: { plan: string; used: number; limit: number; paygo_used: number; paygo_limit: number | null };
  cost_usd?: number;
  organization_balance?: { credits_cents: number; pending_debit_cents: number; postpaid: boolean; scope: string };
  money_balance?: {
    credits_cents: number; invoice_debt_cents: number; available_cents: number; scope: string;
    enterprise: boolean; expiring: { balance_cents: number; expires_at: string }[];
  };
  balance?: { free_limit: number; charged_used: number; free_remaining: number; paid_remaining: number; scope: string };
  request_quota?: {
    total: number; used: number; remaining: number; scope: string; tier: string;
    reset_period: 'daily' | 'monthly' | 'none'; next_reset_at: string | null;
    key_used: number; key_limit: number | null;
    total_calls: number | null; month_calls: number | null;
  };
};
export type KeyPublic = {
  id: string; provider: Provider; label: string; account: string; masked: string;
  enabled: boolean; state: string; cooldown_until: string | null; last_error: string | null;
  last_used: string | null; created_at: string; max_concurrency: number; exa_key_id: string;
  has_management_key: boolean; calls: number; successes: number; cost_usd: number; credits: number;
  usage: UsageSnapshot | null; usage_error: string | null;
  keenable_login?: { expires_at: string; needs_login: boolean };
  anysearch_login?: { expires_at: string; needs_login: boolean };
  exa_login?: { expires_at: string; needs_login: boolean; team_id: string };
  parallel_login?: { expires_at: string; needs_login: boolean; org_id: string; org_name: string };
  metering: { month: string; reported_credits: number; reported_calls: number; estimated_credits: number; estimated_calls: number; unreported_calls: number };
};
export type SearchInput = {
  query: string; profile?: string; max_results?: number; include_domains?: string[]; exclude_domains?: string[];
  per_provider_results?: number;
};
export type Evidence = RouteInfo & {
  provider: Provider; mode: string; query: string; rank: number; retrieved_at: string;
  title: string; url: string; snippet: string; content?: string; published_at?: string; acquired_at?: string;
  truncated?: boolean; preview_truncated?: boolean;
};
export type SearchResult = {
  title: string; url: string; snippet: string; published_at?: string;
  sources: Provider[]; score: number; evidence: Evidence[];
};
export type ProviderOutcome = RouteInfo & { provider: Provider; mode: string; requested_mode?: string; status: 'success' | 'error'; count: number; duration_ms: number; error?: string; requested_results?: number; effective_limit?: number | null; limit_reached?: boolean; unique_urls?: number; exclusive_urls?: number; warnings?: string[] };
export type SearchResponse = {
  request_id: string; query: string; profile: string; results: SearchResult[];
  providers: ProviderOutcome[]; partial: boolean; cache_hit: boolean; duration_ms: number;
  collection_id: string; total_results: number; offset: number; next_offset: number | null; collected_at: string;
  scope: { input: SearchInput; profile: Profile; filtered_results: number; note: string };
};
export type ResultsInput = { collection_id: string; offset?: number; limit?: number };
export type EvidenceInput = { collection_id: string; url: string; offset?: number; limit?: number };
export type EvidenceResponse = { collection_id: string; url: string; evidence: Evidence[]; offset: number; next_offset: number | null; total_characters: number };
export type Settings = { default_profile: string; daily_call_limit: number; usage_sync_minutes: number };
export type ParallelAuthorization = { id: string; user_code: string; verification_uri: string; expires_at: string; poll_after_seconds: number };
export type ParallelAuthPoll = { status: 'pending'; poll_after_seconds: number } | { status: 'connected' };
export type TokenPublic = { id: string; name: string; masked: string; enabled: boolean; created_at: string; last_used: string | null };
export type RequestLog = {
  id: string; caller: string; operation: string; query: string; profile: string; status: string;
  cache_hit: number; duration_ms: number; created_at: string; calls: CallLog[];
};
export type CallLog = RouteInfo & {
  id: string; request_id: string; provider: Provider; key_id: string | null; key_label: string; account: string;
  masked: string; mode: string; operation: string; status: string; http_status: number | null;
  error_code: string | null; duration_ms: number; result_count: number; cost_usd: number | null; paid?: boolean | null;
  credits: number | null; billing_source: string; created_at: string; usage_items?: { name: string; count: number }[];
};
export type Dashboard = {
  requests: number; calls: number; successes: number; avg_latency_ms: number; cache_hits: number;
  reported_cost_usd: number; reported_credits: number; estimated_credits: number;
  credits_by_provider: { provider: Provider; reported: number; estimated: number; paid: number }[];
  keys: number; ready_keys: number; accounts: number; daily_call_limit: number;
  daily: { date: string; requests: number; calls: number }[];
  providers: { provider: Provider; calls: number; successes: number; avg_latency_ms: number }[];
};
