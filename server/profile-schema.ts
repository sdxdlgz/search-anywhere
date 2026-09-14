import { z } from 'zod';
import { MODES, PROVIDERS } from '../shared/types.js';

export const profileSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), name: z.string().trim().min(1).max(100),
  modes: z.object({ exa: z.string().nullable(), parallel: z.string().nullable(), tavily: z.string().nullable(), anysearch: z.string().nullable().default(null), keenable: z.string().nullable().default(null) }).strict(),
  max_results: z.number().int().min(1).max(30), per_provider_results: z.number().int().min(1).max(100).optional(), fetch_strategy: z.enum(['fallback', 'parallel']).optional(), parallel_transport: z.enum(['free_first', 'api']).optional(), timeout_ms: z.number().int().min(1000).max(180000), cache_ttl_seconds: z.number().int().min(0).max(3600), version: z.number().int().optional(),
}).strict().superRefine((p, ctx) => {
  for (const provider of PROVIDERS) if (p.modes[provider] && !MODES[provider].includes(p.modes[provider]!)) ctx.addIssue({ code: 'custom', path: ['modes', provider], message: '该供应商不支持此模式' });
  if (!PROVIDERS.some(provider => p.modes[provider])) ctx.addIssue({ code: 'custom', path: ['modes'], message: '至少启用一家供应商' });
});
export const retentionPolicySchema = z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(3650) }).strict();
const cleanupResultSchema = z.object({ completed_at: z.string().datetime(), cutoff: z.string().datetime(), source: z.enum(['manual', 'automatic']),
  requests: z.number().int().nonnegative(), collections: z.number().int().nonnegative(), call_details: z.number().int().nonnegative(), content_bytes: z.number().nonnegative() }).strict();
export const settingsSchema = z.object({ default_profile: z.string().max(50), daily_call_limit: z.number().int().min(0).max(1000000), usage_sync_minutes: z.number().int().min(0).max(1440),
  history_retention: retentionPolicySchema.optional(), history_cleanup: cleanupResultSchema.optional() }).strict();
