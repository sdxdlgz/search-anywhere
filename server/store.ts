import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Vault, hash, mask, newToken } from './security.js';
import { allocateKeyLabels } from './key-labels.js';
import { ExaLedger } from './exa-ledger.js';
import { savedWarnings } from './upstream-warnings.js';
import { backfillRequestCallers, tokenUsage } from './token-usage.js';
import { PROVIDERS, type CallLog, type Dashboard, type KeyPublic, type Profile, type Provider, type ProviderOutcome, type RequestLog, type RouteInfo, type SearchResponse, type Settings, type TokenPublic, type UsageSnapshot } from '../shared/types.js';

export type StoredKey = {
  id: string; provider: Provider; label: string; account: string; masked: string; secret: string;
  enabled: number; state: string; cooldown_until: string | null; last_error: string | null;
  last_used: string | null; created_at: string; max_concurrency: number; exa_key_id: string;
  usage_json: string | null; usage_error: string | null; sequence: number;
};
export type KeyInput = { provider: Provider; label: string; account: string; keys: string[]; max_concurrency: number; exa_key_id?: string; service_key?: string };
export type LoginTokens = { access_token: string; refresh_token: string; expires_at: number };
export type ParallelTokens = LoginTokens & { client_id: string; org_id: string; org_name: string; refresh_expires_at?: number; authorization_expires_at?: number };
export type ExaLogin = { cookie: string; team_id: string };
export type StoredLoginSession = { key_id: string; secret: string; generation: string; version: string; expires_at: string; needs_login: number };
export type KeenableTokens = LoginTokens;
export type StoredKeenableSession = StoredLoginSession;
const loginTable = (provider?: Provider) => provider === 'keenable' || provider === 'anysearch' || provider === 'exa' || provider === 'parallel' ? `${provider}_sessions` : undefined;
const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  readonly exaLedger: ExaLedger;
  revision = 0;
  maintenance = false;
  readonly inflight = new Map<string, number>();
  constructor(readonly directory: string) {
    this.vault = new Vault(directory);
    this.db = new DatabaseSync(join(directory, 'gateway.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, account TEXT NOT NULL,
        masked TEXT NOT NULL, secret TEXT NOT NULL, fingerprint TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'ready', cooldown_until TEXT,
        last_error TEXT, last_used TEXT, created_at TEXT NOT NULL, max_concurrency INTEGER NOT NULL DEFAULT 2,
        exa_key_id TEXT NOT NULL DEFAULT '', usage_json TEXT, usage_error TEXT, sequence INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider, fingerprint));
      CREATE TABLE IF NOT EXISTS account_secrets (provider TEXT, account TEXT, secret TEXT NOT NULL, PRIMARY KEY(provider, account));
      CREATE TABLE IF NOT EXISTS keenable_sessions (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        secret TEXT NOT NULL, generation TEXT NOT NULL, version TEXT NOT NULL,
        expires_at TEXT NOT NULL, needs_login INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS anysearch_sessions (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        secret TEXT NOT NULL, generation TEXT NOT NULL, version TEXT NOT NULL,
        expires_at TEXT NOT NULL, needs_login INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS exa_sessions (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        secret TEXT NOT NULL, generation TEXT NOT NULL, version TEXT NOT NULL,
        expires_at TEXT NOT NULL, needs_login INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS parallel_sessions (
        key_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        secret TEXT NOT NULL, generation TEXT NOT NULL, version TEXT NOT NULL,
        expires_at TEXT NOT NULL, needs_login INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_clients (provider TEXT PRIMARY KEY, client_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, masked TEXT NOT NULL, fingerprint TEXT UNIQUE NOT NULL, enabled INTEGER DEFAULT 1, created_at TEXT, last_used TEXT);
      CREATE TABLE IF NOT EXISTS sessions (fingerprint TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, caller TEXT, operation TEXT, query TEXT, profile TEXT, status TEXT, cache_hit INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, created_at TEXT, caller_id TEXT);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, request_id TEXT, provider TEXT, key_id TEXT, key_label TEXT, account TEXT, masked TEXT,
        mode TEXT, operation TEXT, status TEXT, http_status INTEGER, error_code TEXT, duration_ms INTEGER DEFAULT 0,
        result_count INTEGER DEFAULT 0, cost_usd REAL, credits REAL, billing_source TEXT DEFAULT 'unknown', created_at TEXT);
      CREATE INDEX IF NOT EXISTS calls_time ON calls(created_at);
      CREATE INDEX IF NOT EXISTS calls_request ON calls(request_id);
      CREATE INDEX IF NOT EXISTS calls_key ON calls(key_id);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(created_at);
      CREATE INDEX IF NOT EXISTS collections_time ON collections(created_at);
      DELETE FROM client_tokens WHERE enabled IS NOT 1;
      UPDATE calls SET status='error', error_code='interrupted' WHERE status='running';
      UPDATE requests SET status='error' WHERE status='running';
    `);
    const callColumns = this.all<{ name: string }>('PRAGMA table_info(calls)');
    for (const [name, type] of [['usage_json', 'TEXT'], ['paid', 'INTEGER'], ['transport', "TEXT DEFAULT 'api'"], ['fallback_reason', 'TEXT'], ['billing_scope', 'TEXT'], ['warnings_json', 'TEXT']]) {
      if (!callColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
    }
    if (!this.all<{ name: string }>('PRAGMA table_info(requests)').some(c => c.name === 'caller_id')) this.db.exec('ALTER TABLE requests ADD COLUMN caller_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS requests_caller_time ON requests(caller_id,created_at)');
    backfillRequestCallers(this);
    this.db.exec(`CREATE INDEX IF NOT EXISTS calls_details_time ON calls(created_at) WHERE key_label IS NOT NULL;
      CREATE INDEX IF NOT EXISTS requests_history_time ON requests(created_at) WHERE query IS NOT NULL;
      CREATE INDEX IF NOT EXISTS calls_running ON calls(request_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS requests_running ON requests(id) WHERE status='running';`);
    this.exaLedger = new ExaLedger(this);
    if (!this.get('SELECT id FROM settings WHERE id=1')) this.run('INSERT INTO settings VALUES(1, ?)', JSON.stringify({ default_profile: 'coverage', daily_call_limit: 0, usage_sync_minutes: 30 }));
    if (!this.get('SELECT id FROM profiles LIMIT 1')) this.seedProfiles();
    if (!this.profile('coverage')) this.saveProfile({ id: 'coverage', name: '覆盖优先', modes: { exa: 'deep-reasoning', parallel: 'advanced', tavily: 'advanced', anysearch: 'auto', keenable: 'pro' }, max_results: 10, per_provider_results: 100, fetch_strategy: 'parallel', timeout_ms: 120000, cache_ttl_seconds: 0, version: 1 });
  }
  get<T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  private seedProfiles() {
    const presets = [
      { id: 'fast', name: '快速搜索', modes: { exa: 'fast', parallel: 'fast', tavily: 'fast' }, timeout_ms: 8000 },
      { id: 'balanced', name: '均衡搜索', modes: { exa: 'auto', parallel: 'basic', tavily: 'basic' }, timeout_ms: 15000 },
      { id: 'thorough', name: '深入搜索', modes: { exa: 'deep', parallel: 'advanced', tavily: 'advanced' }, timeout_ms: 45000 },
    ];
    for (const p of presets) this.saveProfile({ ...p, max_results: 10, cache_ttl_seconds: 120, version: 1 });
  }
  profiles(): Profile[] { return this.all<{ value: string }>('SELECT value FROM profiles ORDER BY rowid').map(r => { const p: Profile = JSON.parse(r.value); return { ...p, modes: { anysearch: null, keenable: null, ...p.modes }, per_provider_results: p.per_provider_results ?? p.max_results, fetch_strategy: p.fetch_strategy ?? 'fallback', parallel_transport: p.parallel_transport ?? 'free_first' }; }); }
  profile(id?: string): Profile | undefined { return this.profiles().find(p => p.id === (id || this.settings().default_profile)); }
  saveProfile(p: Profile) {
    const old = this.get<{ value: string }>('SELECT value FROM profiles WHERE id=?', p.id);
    const value = { ...p, version: old ? JSON.parse(old.value).version + 1 : 1 };
    this.run('INSERT INTO profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', p.id, JSON.stringify(value));
    this.revision++;
    return value;
  }
  settings(): Settings { return { history_retention: { enabled: true, days: 7 }, ...JSON.parse(this.get<{ value: string }>('SELECT value FROM settings WHERE id=1')!.value) }; }
  saveSettings(s: Settings) { this.run('UPDATE settings SET value=? WHERE id=1', JSON.stringify({ ...this.settings(), ...s })); this.revision++; }
  key(id: string) { return this.get<StoredKey>('SELECT * FROM credentials WHERE id=?', id); }
  secret(key: StoredKey) { return this.vault.decrypt(key.secret); }
  managementSecret(account: string): string | undefined {
    const row = this.get<{ secret: string }>('SELECT secret FROM account_secrets WHERE provider=? AND account=?', 'exa', account);
    return row ? this.vault.decrypt(row.secret) : undefined;
  }
  createKeys(input: KeyInput): KeyPublic[] {
    const ids = this.transaction(() => {
      const result: string[] = [];
      const labels = allocateKeyLabels(input.label, input.keys.length, this.all<{ label: string }>('SELECT label FROM credentials WHERE provider=?', input.provider).map(key => key.label));
      for (const [index, value] of input.keys.entries()) {
        const id = randomUUID();
        this.run('INSERT INTO credentials(id,provider,label,account,masked,secret,fingerprint,created_at,max_concurrency,exa_key_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
          id, input.provider, labels[index], input.account,
          mask(value), this.vault.encrypt(value), hash(value), now(), input.max_concurrency, input.exa_key_id || '');
        result.push(id);
      }
      if (input.service_key && input.provider === 'exa') this.setManagementSecret(input.account, input.service_key);
      return result;
    });
    this.revision++;
    return this.keys().filter(k => ids.includes(k.id));
  }
  setManagementSecret(account: string, value: string) {
    this.run('INSERT INTO account_secrets VALUES(?,?,?) ON CONFLICT(provider,account) DO UPDATE SET secret=excluded.secret', 'exa', account, this.vault.encrypt(value));
  }
  keenableSession(id: string) { return this.get<StoredKeenableSession>('SELECT * FROM keenable_sessions WHERE key_id=?', id); }
  keenableTokens(session: StoredKeenableSession): KeenableTokens { return this.loginTokens(session); }
  setKeenableSession(id: string, tokens: KeenableTokens) {
    if (this.key(id)?.provider !== 'keenable') throw new Error('Keenable key required');
    this.setLoginSession(id, tokens);
  }
  rotateKeenableSession(session: StoredKeenableSession, tokens: KeenableTokens) { return this.rotateLoginSession(session, tokens); }
  invalidateKeenableSession(session: StoredKeenableSession) { this.invalidateLoginSession(session); }
  removeKeenableSession(id: string) { this.removeLoginSession(id); }
  loginSession(id: string): StoredLoginSession | undefined {
    const table = loginTable(this.key(id)?.provider);
    return table ? this.get<StoredLoginSession>(`SELECT * FROM ${table} WHERE key_id=?`, id) : undefined;
  }
  loginTokens(session: StoredLoginSession): LoginTokens { return JSON.parse(this.vault.decrypt(session.secret)); }
  parallelTokens(session: StoredLoginSession): ParallelTokens { return JSON.parse(this.vault.decrypt(session.secret)); }
  parallelClientId(): string | undefined { return this.get<{ client_id: string }>("SELECT client_id FROM oauth_clients WHERE provider='parallel'")?.client_id; }
  setParallelClientId(id: string) { this.run("INSERT INTO oauth_clients VALUES('parallel',?) ON CONFLICT(provider) DO UPDATE SET client_id=excluded.client_id", id); }
  exaLogin(session: StoredLoginSession): ExaLogin { return JSON.parse(this.vault.decrypt(session.secret)); }
  setExaSession(id: string, login: ExaLogin) {
    if (this.key(id)?.provider !== 'exa') throw new Error('Exa key required');
    this.setLoginValue(id, JSON.stringify(login), new Date(0).toISOString());
  }
  setLoginSession(id: string, tokens: LoginTokens) {
    this.setLoginValue(id, JSON.stringify(tokens), new Date(tokens.expires_at * 1000).toISOString());
  }
  private setLoginValue(id: string, value: string, expiresAt: string) {
    const table = loginTable(this.key(id)?.provider);
    if (!table) throw new Error('Website login is not supported for this key');
    this.run(`INSERT INTO ${table} VALUES(?,?,?,?,?,0) ON CONFLICT(key_id) DO UPDATE SET
      secret=excluded.secret,generation=excluded.generation,version=excluded.version,expires_at=excluded.expires_at,needs_login=0`,
    id, this.vault.encrypt(value), randomUUID(), randomUUID(), expiresAt);
  }
  rotateLoginSession(session: StoredLoginSession, tokens: LoginTokens) {
    return this.rotateLoginValue(session, JSON.stringify(tokens), new Date(tokens.expires_at * 1000).toISOString());
  }
  rotateExaSession(session: StoredLoginSession, login: ExaLogin, expiresAt: string) {
    return this.rotateLoginValue(session, JSON.stringify(login), expiresAt);
  }
  private rotateLoginValue(session: StoredLoginSession, value: string, expiresAt: string) {
    const table = loginTable(this.key(session.key_id)?.provider);
    if (!table) return false;
    return !!this.run(`UPDATE ${table} SET secret=?,version=?,expires_at=?,needs_login=0 WHERE key_id=? AND version=?`,
      this.vault.encrypt(value), randomUUID(), expiresAt, session.key_id, session.version).changes;
  }
  invalidateLoginSession(session: StoredLoginSession) {
    const table = loginTable(this.key(session.key_id)?.provider);
    if (table) this.run(`UPDATE ${table} SET needs_login=1 WHERE key_id=? AND version=?`, session.key_id, session.version);
  }
  removeLoginSession(id: string) {
    const table = loginTable(this.key(id)?.provider);
    if (!table) return;
    this.transaction(() => {
      this.run(`DELETE FROM ${table} WHERE key_id=?`, id);
      this.run('UPDATE credentials SET usage_json=NULL,usage_error=NULL WHERE id=?', id);
    });
  }
  updateKey(id: string, data: { label: string; account: string; enabled: boolean; max_concurrency: number; exa_key_id: string; service_key?: string; reset?: boolean }) {
    const old = this.key(id);
    if (!old) return false;
    this.run('UPDATE credentials SET label=?,account=?,enabled=?,max_concurrency=?,exa_key_id=? WHERE id=?', data.label, data.account, Number(data.enabled), data.max_concurrency, data.exa_key_id, id);
    if (data.account !== old.account) this.run('UPDATE credentials SET usage_json=NULL,usage_error=NULL WHERE id=?', id);
    if (data.reset || (!old.enabled && data.enabled)) this.setKeyState(id, 'ready', null, null);
    if (data.service_key && old.provider === 'exa') this.setManagementSecret(data.account, data.service_key);
    this.revision++;
    return true;
  }
  deleteKey(id: string): boolean {
    const result = this.run('DELETE FROM credentials WHERE id=?', id).changes;
    this.run('DELETE FROM account_secrets WHERE NOT EXISTS (SELECT 1 FROM credentials c WHERE c.provider=account_secrets.provider AND c.account=account_secrets.account)');
    this.revision++;
    return !!result;
  }
  keys(): KeyPublic[] {
    const month = now().slice(0, 7);
    return this.all<StoredKey>('SELECT * FROM credentials ORDER BY created_at').map(k => {
      const stats = this.get<{ calls: number; successes: number; cost_usd: number; credits: number }>(
        "SELECT COUNT(*) calls, COALESCE(SUM(status='success'),0) successes, COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(credits),0) credits FROM calls WHERE key_id=?", k.id)!;
      const state = k.cooldown_until && k.cooldown_until <= now() && ['cooldown', 'exhausted'].includes(k.state) ? 'ready' : k.state;
      const metering = this.get<Omit<KeyPublic['metering'], 'month'>>(`SELECT
        COALESCE(SUM(CASE WHEN billing_source='reported' THEN credits END),0) reported_credits,
        COALESCE(SUM(billing_source='reported' AND credits IS NOT NULL),0) reported_calls,
        COALESCE(SUM(CASE WHEN billing_source='estimated' THEN credits END),0) estimated_credits,
        COALESCE(SUM(billing_source='estimated' AND credits IS NOT NULL),0) estimated_calls,
        COALESCE(SUM(status='success' AND billing_source='unknown'),0) unreported_calls
        FROM calls WHERE key_id=? AND created_at>=?`, k.id, `${month}-01T00:00:00.000Z`)!;
      const login = loginTable(k.provider) ? this.loginSession(k.id) : undefined;
      return { id: k.id, provider: k.provider, label: k.label, account: k.account, masked: k.masked, enabled: !!k.enabled,
        state: k.enabled ? state : 'disabled', cooldown_until: k.cooldown_until, last_error: k.last_error,
        last_used: k.last_used, created_at: k.created_at, max_concurrency: k.max_concurrency, exa_key_id: k.exa_key_id,
        has_management_key: !!this.get('SELECT 1 FROM account_secrets WHERE provider=? AND account=?', k.provider, k.account),
        ...(login ? { [`${k.provider}_login`]: { expires_at: login.expires_at, needs_login: !!login.needs_login, ...(k.provider === 'exa' ? { team_id: this.exaLogin(login).team_id } : {}), ...(k.provider === 'parallel' ? { org_id: this.parallelTokens(login).org_id, org_name: this.parallelTokens(login).org_name } : {}) } } : {}),
        ...(k.provider === 'exa' ? { exa_balance: this.exaLedger.publicState(k) } : {}),
        ...stats, metering: { month, ...metering }, usage: this.exaLedger.isManual(k.id) ? this.exaLedger.manualUsage(k.id)! : k.usage_json ? JSON.parse(k.usage_json) : null, usage_error: this.exaLedger.isManual(k.id) ? null : k.usage_error };
    });
  }
  reserve(provider: Provider, excluded: string[] = [], forcedId?: string): StoredKey | undefined {
    const timestamp = now();
    this.run("UPDATE credentials SET state='ready',cooldown_until=NULL WHERE enabled=1 AND state IN ('cooldown','exhausted') AND cooldown_until<=?", timestamp);
    const candidates = this.all<StoredKey>("SELECT * FROM credentials WHERE provider=? AND enabled=1 AND state='ready' ORDER BY sequence,created_at,id", provider);
    const key = candidates.find(k => !excluded.includes(k.id) && (!forcedId || forcedId === k.id) && (this.inflight.get(k.id) || 0) < k.max_concurrency);
    if (!key) return;
    const sequence = this.get<{ value: number }>('SELECT COALESCE(MAX(sequence),0)+1 value FROM credentials')!.value;
    this.run('UPDATE credentials SET sequence=?,last_used=? WHERE id=?', sequence, timestamp, key.id);
    this.inflight.set(key.id, (this.inflight.get(key.id) || 0) + 1);
    return key;
  }
  release(id: string) { const count = (this.inflight.get(id) || 1) - 1; if (count) this.inflight.set(id, count); else this.inflight.delete(id); }
  setKeyState(id: string, state: string, error: string | null, until: string | null) {
    this.run('UPDATE credentials SET state=?,last_error=?,cooldown_until=? WHERE id=?', state, error, until, id);
  }
  setUsage(id: string, usage: UsageSnapshot) { this.run('UPDATE credentials SET usage_json=?,usage_error=NULL WHERE id=?', JSON.stringify(usage), id); }
  usageError(id: string, message: string) { this.run('UPDATE credentials SET usage_error=? WHERE id=?', message, id); }
  createToken(name: string): TokenPublic & { token: string } {
    const token = newToken('sa'), id = randomUUID();
    this.run('INSERT INTO client_tokens(id,name,masked,fingerprint,created_at) VALUES(?,?,?,?,?)', id, name, mask(token), hash(token), now());
    return { ...this.tokens().find(t => t.id === id)!, token };
  }
  tokens(): TokenPublic[] {
    const usage = tokenUsage(this);
    return this.all<Omit<TokenPublic, 'enabled'> & { enabled: number }>('SELECT id,name,masked,enabled,created_at,last_used FROM client_tokens ORDER BY created_at').map(t => ({ ...t, enabled: !!t.enabled, usage: usage.get(t.id)! }));
  }
  authenticateToken(token: string): { id: string; name: string } | undefined {
    const row = this.get<{ id: string; name: string }>('SELECT id,name FROM client_tokens WHERE fingerprint=? AND enabled=1', hash(token));
    if (row) this.run('UPDATE client_tokens SET last_used=? WHERE id=?', now(), row.id);
    return row;
  }
  deleteToken(id: string) { this.run('DELETE FROM client_tokens WHERE id=?', id); }
  createSession() { const token = newToken('session'); this.run('INSERT INTO sessions VALUES(?,?)', hash(token), Date.now() + 86400000); return token; }
  validSession(token: string) { return !!this.get('SELECT 1 FROM sessions WHERE fingerprint=? AND expires>?', hash(token), Date.now()); }
  endSession(token: string) { this.run('DELETE FROM sessions WHERE fingerprint=?', hash(token)); }
  beginRequest(caller: string, operation: string, query: string, profile: string, callerId?: string): string {
    const id = randomUUID();
    this.run("INSERT INTO requests(id,caller,operation,query,profile,status,created_at,caller_id) VALUES(?,?,?,?,?,'running',?,?)", id, caller, operation, query, profile, now(), callerId ?? null);
    return id;
  }
  finishRequest(id: string, status: string, duration: number, cached = false) { this.run('UPDATE requests SET status=?,duration_ms=?,cache_hit=? WHERE id=?', status, duration, Number(cached), id); }
  saveCollection(callerId: string, value: SearchResponse) { this.run('INSERT INTO collections VALUES(?,?,?,?)', value.collection_id, callerId, JSON.stringify(value), value.collected_at); }
  collection(id: string, callerId: string): SearchResponse | undefined {
    const row = this.get<{ value: string }>('SELECT value FROM collections WHERE id=? AND (caller_id=? OR ?=\'admin\')', id, callerId, callerId);
    if (!row) return undefined;
    const value = JSON.parse(row.value) as SearchResponse;
    value.providers = value.providers.map(p => ({ ...p, ...(p.warnings ? { warnings: savedWarnings(p.warnings) } : {}) }));
    return value;
  }
  beginCall(requestId: string, key: Pick<StoredKey, 'provider' | 'label' | 'account' | 'masked'> & { id: string | null }, mode: string, operation: string, route: RouteInfo = {}): string | undefined {
    const limit = this.settings().daily_call_limit;
    if (limit > 0 && this.todayCalls() >= limit) return;
    const id = randomUUID();
    this.run("INSERT INTO calls(id,request_id,provider,key_id,key_label,account,masked,mode,operation,status,created_at,transport,fallback_reason,billing_scope) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?,?)", id, requestId, key.provider, key.id, key.label, key.account, key.masked, mode, operation, now(), route.transport ?? 'api', route.fallback_reason ?? null, key.provider === 'exa' && key.id ? this.exaLedger.scope(key.id) : null);
    return id;
  }
  finishCall(id: string, data: { status: string; duration_ms: number; result_count?: number; http_status?: number | null; error_code?: string | null; cost_usd?: number | null; credits?: number | null; paid?: boolean | null; billing_source?: string; usage_items?: { name: string; count: number }[]; warnings?: string[] }) {
    this.run('UPDATE calls SET status=?,duration_ms=?,result_count=?,http_status=?,error_code=?,cost_usd=?,credits=?,billing_source=?,usage_json=? WHERE id=?', data.status, data.duration_ms, data.result_count || 0, data.http_status ?? null, data.error_code ?? null, data.cost_usd ?? null, data.credits ?? null, data.billing_source || 'unknown', data.usage_items?.length ? JSON.stringify(data.usage_items) : null, id);
    this.run('UPDATE calls SET paid=?,warnings_json=? WHERE id=?', data.paid == null ? null : Number(data.paid), JSON.stringify(data.warnings || []), id);
  }
  todayCalls() { return this.get<{ count: number }>("SELECT COUNT(*) count FROM calls WHERE created_at>=?", new Date().toISOString().slice(0, 10))!.count; }
  logs(limit = 50, offset = 0): RequestLog[] {
    const rows = this.all<Omit<RequestLog, 'calls'> & { stored_providers: string | null }>('SELECT r.*,json_extract(c.value,\'$.providers\') AS stored_providers FROM requests r LEFT JOIN collections c ON c.id=r.id WHERE r.query IS NOT NULL ORDER BY r.created_at DESC LIMIT ? OFFSET ?', limit, offset);
    return rows.map(({ stored_providers, ...request }) => {
      const previous: ProviderOutcome[] = stored_providers ? JSON.parse(stored_providers) : [];
      const calls = this.all<CallLog & { usage_json: string | null; warnings_json: string | null }>('SELECT * FROM calls WHERE request_id=? ORDER BY created_at', request.id).map(({ usage_json, warnings_json, ...call }) => {
        const legacy = call.status === 'success' ? previous.find(p => p.provider === call.provider && p.mode === call.mode && (p.transport || 'api') === (call.transport || 'api'))?.warnings : undefined;
        return { ...call, usage_items: usage_json ? JSON.parse(usage_json) : [], warnings: savedWarnings(warnings_json ? JSON.parse(warnings_json) : legacy) };
      });
      return { ...request, calls };
    });
  }
  dashboard(): Dashboard {
    const since = new Date().toISOString().slice(0, 10);
    const requests = this.get<{ requests: number; cache_hits: number; avg_latency_ms: number }>('SELECT COUNT(*) requests,COALESCE(SUM(cache_hit),0) cache_hits,COALESCE(AVG(duration_ms),0) avg_latency_ms FROM requests WHERE created_at>=?', since)!;
    const calls = this.get<{ calls: number; successes: number; reported_cost_usd: number; reported_credits: number; estimated_credits: number }>("SELECT COUNT(*) calls,COALESCE(SUM(status='success'),0) successes,COALESCE(SUM(CASE WHEN billing_source='reported' THEN cost_usd END),0) reported_cost_usd,COALESCE(SUM(CASE WHEN billing_source='reported' THEN credits END),0) reported_credits,COALESCE(SUM(CASE WHEN billing_source='estimated' THEN credits END),0) estimated_credits FROM calls WHERE created_at>=?", since)!;
    const keys = this.keys();
    const daily = Array.from({ length: 7 }, (_, i) => { const date = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10); return { date,
      requests: this.get<{ n: number }>('SELECT COUNT(*) n FROM requests WHERE substr(created_at,1,10)=?', date)!.n,
      calls: this.get<{ n: number }>('SELECT COUNT(*) n FROM calls WHERE substr(created_at,1,10)=?', date)!.n }; });
    const credits_by_provider = PROVIDERS.map(provider => ({ provider, ...this.get<{ reported: number; estimated: number; paid: number }>("SELECT COALESCE(SUM(CASE WHEN billing_source='reported' THEN credits END),0) reported, COALESCE(SUM(CASE WHEN billing_source='estimated' THEN credits END),0) estimated, COALESCE(SUM(CASE WHEN paid=1 THEN credits END),0) paid FROM calls WHERE provider=? AND created_at>=?", provider, since)! }));
    const tavily = credits_by_provider.find(p => p.provider === 'tavily')!;
    return { ...requests, ...calls, reported_credits: tavily.reported, estimated_credits: tavily.estimated, credits_by_provider, keys: keys.length, ready_keys: keys.filter(k => k.state === 'ready').length,
      accounts: new Set(keys.map(k => `${k.provider}:${k.account}`)).size, daily_call_limit: this.settings().daily_call_limit, daily,
      providers: PROVIDERS.map(provider => ({ provider, ...this.get<{ calls: number; successes: number; avg_latency_ms: number }>("SELECT COUNT(*) calls,COALESCE(SUM(status='success'),0) successes,COALESCE(AVG(duration_ms),0) avg_latency_ms FROM calls WHERE provider=? AND created_at>=?", provider, since)! })) };
  }
}
