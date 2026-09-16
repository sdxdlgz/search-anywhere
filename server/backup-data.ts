import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Store } from './store.js';
import { hash, mask } from './security.js';
import { canonicalUrl } from './providers.js';
import { PROVIDERS, type BackupSummary } from '../shared/types.js';
import { profileSchema, settingsSchema } from './profile-schema.js';
import { invalidBackup, MAX_PAYLOAD_BYTES } from './backup-crypto.js';
import { GatewayError } from './upstream.js';
import { backfillRequestCallers } from './token-usage.js';

// The allowlist prevents importing SQL, browser sessions, host files or future tables.
export const BACKUP_TABLES = ['credentials', 'account_secrets', 'keenable_sessions', 'anysearch_sessions', 'exa_sessions', 'parallel_sessions', 'oauth_clients', 'profiles', 'settings', 'client_tokens', 'requests', 'collections', 'calls', 'exa_balance_preferences', 'exa_balance_calibrations', 'exa_usage_blocks'] as const;
type Table = typeof BACKUP_TABLES[number];
type Row = Record<string, SQLInputValue>;
export type BackupData = { format: 'search-anywhere'; version: 1; created_at: string; tables: Record<Table, Row[]> };
const scalar = z.union([z.string(), z.number().finite(), z.null()]);
const schema = z.object({ format: z.literal('search-anywhere'), version: z.literal(1), created_at: z.string().datetime(), tables: z.object(Object.fromEntries(BACKUP_TABLES.map(t => [t, z.array(z.record(z.string(), scalar))]))).strict() }).strict();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function columns(store: Store, table: Table): string[] { return ['rowid', ...store.all<{ name: string }>(`PRAGMA table_info(${quote(table)})`).map(c => c.name)]; }
function secretTable(table: Table) { return table === 'credentials' || table === 'account_secrets' || table.endsWith('_sessions'); }

export function captureBackup(store: Store): BackupData {
  let bytes = 0;
  const tables = Object.fromEntries(BACKUP_TABLES.map(table => {
    const rows: Row[] = [];
    for (const raw of store.db.prepare(`SELECT rowid AS __backup_rowid,* FROM ${quote(table)} ORDER BY rowid`).iterate()) {
      const { __backup_rowid, ...fields } = raw;
      const row = { rowid: __backup_rowid, ...fields } as Row;
      if (secretTable(table)) row.secret = store.vault.decrypt(String(row.secret));
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > MAX_PAYLOAD_BYTES) throw new GatewayError('数据超过网页备份限制，请停机后整体备份数据目录。', 'backup_too_large', 413);
      rows.push(row);
    }
    return [table, rows];
  })) as BackupData['tables'];
  return { format: 'search-anywhere', version: 1, created_at: new Date().toISOString(), tables };
}

function insertRows(db: DatabaseSync, store: Store, data: BackupData, encrypt: boolean) {
  for (const table of BACKUP_TABLES) {
    const names = columns(store, table);
    const statement = db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
    for (const row of data.tables[table]) statement.run(...names.map(name => encrypt && name === 'secret' && secretTable(table) ? store.vault.encrypt(String(row[name])) : row[name]));
  }
}

function checkRecords(data: BackupData) {
  for (const key of data.tables.credentials) {
    if (!PROVIDERS.includes(key.provider as typeof PROVIDERS[number]) || typeof key.secret !== 'string' || key.secret.length < 8 || key.secret.length > 512 || /\s/.test(key.secret) || key.fingerprint !== hash(key.secret) || key.masked !== mask(key.secret)) throw invalidBackup();
    if (!z.string().uuid().safeParse(key.id).success || typeof key.label !== 'string' || typeof key.account !== 'string' || ![0, 1].includes(Number(key.enabled)) || !Number.isInteger(key.max_concurrency) || Number(key.max_concurrency) < 1 || Number(key.max_concurrency) > 16) throw invalidBackup();
  }
  for (const table of BACKUP_TABLES.filter(t => t.endsWith('_sessions'))) {
    for (const session of data.tables[table]) {
      const login = JSON.parse(String(session.secret));
      const provider = data.tables.credentials.find(k => k.id === session.key_id)?.provider;
      if (`${provider}_sessions` !== table) throw invalidBackup();
      if (provider === 'exa') { if (typeof login.cookie !== 'string' || typeof login.team_id !== 'string') throw invalidBackup(); }
      else if (typeof login.access_token !== 'string' || typeof login.refresh_token !== 'string' || !Number.isFinite(login.expires_at)) throw invalidBackup();
      if (provider === 'parallel' && ['org_id', 'org_name', 'client_id'].some(k => typeof login[k] !== 'string')) throw invalidBackup();
    }
  }
  const profiles = data.tables.profiles.map(row => {
    const p = profileSchema.parse(JSON.parse(String(row.value)));
    if (p.id !== row.id) throw invalidBackup();
    return p;
  });
  if (data.tables.settings.length !== 1) throw invalidBackup();
  const settings = settingsSchema.parse(JSON.parse(String(data.tables.settings[0].value)));
  if (!profiles.some(p => p.id === settings.default_profile)) throw invalidBackup();
  for (const preference of data.tables.exa_balance_preferences) if (preference.mode === 'manual' && !data.tables.exa_balance_calibrations.some(c => c.scope === preference.scope)) throw invalidBackup();
  const owners = new Map(data.tables.requests.map(row => [row.id, row.caller_id]));
  for (const owner of owners.values()) if (owner !== null && (typeof owner !== 'string' || !owner || owner.length > 128)) throw invalidBackup();
  for (const row of data.tables.collections) {
    const owner = owners.get(row.id);
    if (owner != null && owner !== row.caller_id) throw invalidBackup();
    const c = JSON.parse(String(row.value));
    if (c.collection_id !== row.id || !Array.isArray(c.results) || c.total_results !== c.results.length || !Array.isArray(c.providers)) throw invalidBackup();
    for (const r of c.results) if (typeof r.url !== 'string' || !canonicalUrl(r.url) || !Array.isArray(r.evidence) || r.evidence.some((e: { url?: unknown }) => typeof e.url !== 'string' || !canonicalUrl(e.url))) throw invalidBackup();
  }
}

export function validateBackup(store: Store, value: unknown): BackupData {
  const memory = new DatabaseSync(':memory:');
  try {
    const data = schema.parse(value) as BackupData;
    // Version 1 exports before client metering did not have this nullable column.
    for (const row of data.tables.requests) if (!('caller_id' in row)) row.caller_id = null;
    for (const table of BACKUP_TABLES) {
      const names = columns(store, table);
      memory.exec(store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table)!.sql);
      for (const row of data.tables[table]) {
        if (!Number.isSafeInteger(row.rowid) || Number(row.rowid) < 1 || Object.keys(row).length !== names.length || names.some(n => !(n in row))) throw invalidBackup();
        for (const name of names.filter(n => n.endsWith('_json') || n === 'value')) if (row[name] !== null) JSON.parse(String(row[name]));
        if (secretTable(table) && (typeof row.secret !== 'string' || !row.secret)) throw invalidBackup();
      }
    }
    insertRows(memory, store, data, false);
    if (memory.prepare('PRAGMA foreign_key_check').all().length) throw invalidBackup();
    checkRecords(data);
    // Old exports kept revoked credentials; restoring them must not recreate deleted rows.
    data.tables.client_tokens = data.tables.client_tokens.filter(row => row.enabled === 1);
    return data;
  } catch { throw invalidBackup(); }
  finally { memory.close(); }
}

export function restoreBackup(store: Store, data: BackupData) {
  store.transaction(() => {
    for (const table of [...BACKUP_TABLES].reverse()) store.run(`DELETE FROM ${quote(table)}`);
    insertRows(store.db, store, data, true);
    backfillRequestCallers(store);
    store.run("UPDATE calls SET status='error',error_code='interrupted' WHERE status='running'");
    store.run("UPDATE requests SET status='error' WHERE status='running'");
    if (store.all('PRAGMA foreign_key_check').length) throw invalidBackup();
  });
  store.revision++;
}

export function backupSummary(data: BackupData): BackupSummary {
  return { created_at: data.created_at, format_version: data.version, keys: data.tables.credentials.length,
    providers: Object.fromEntries(PROVIDERS.map(p => [p, data.tables.credentials.filter(k => k.provider === p).length])),
    login_sessions: BACKUP_TABLES.filter(t => t.endsWith('_sessions')).reduce((n, t) => n + data.tables[t].length, 0),
    profiles: data.tables.profiles.length, access_tokens: data.tables.client_tokens.length, calls: data.tables.calls.length, collections: data.tables.collections.length };
}
