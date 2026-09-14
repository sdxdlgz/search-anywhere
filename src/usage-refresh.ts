import type { UsageSnapshot } from '../shared/types';

export type UsageRefreshResult = { id: string; usage?: UsageSnapshot; error?: string };
export type UsagePatch = { usage?: UsageSnapshot; usage_error: string | null };

/** Explicit selection only; no discovery, retries or automatic whole-account expansion. */
export async function refreshSelectedUsage(
  ids: string[], load: (id: string) => Promise<UsageSnapshot>, onResult: (result: UsageRefreshResult) => void,
): Promise<UsageRefreshResult[]> {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error('请选择 1–100 个不同的密钥。');
  const queue = [...ids], results: UsageRefreshResult[] = [];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      let result: UsageRefreshResult;
      try { result = { id, usage: await load(id) }; }
      catch (error) { result = { id, error: error instanceof Error ? error.message : '用量查询失败。' }; }
      results.push(result); onResult(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ids.length, 3) }, worker));
  return results;
}
