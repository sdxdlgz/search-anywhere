import type { Response } from 'express';

type Rpc = { id?: unknown; method?: unknown; params?: { requestId?: unknown } };
const requestKey = (caller: string, id: unknown) => typeof id === 'string' || typeof id === 'number' && Number.isFinite(id) ? JSON.stringify([caller, id]) : undefined;

// Stateless HTTP still sends cancellation as a separate POST. Scope it to the authenticated caller.
export class McpCancellation {
  private active = new Map<string, Set<AbortController>>();
  cancel(caller: string, rpc: Rpc): boolean {
    if (rpc?.method !== 'notifications/cancelled' || rpc.id !== undefined) return false;
    const key = requestKey(caller, rpc.params?.requestId);
    const pending = key ? this.active.get(key) : undefined;
    // Two independent clients can reuse an ID with one token; never guess which they intended.
    if (pending?.size === 1) pending.values().next().value!.abort();
    return true;
  }
  track(caller: string, rpc: Rpc, res: Response): AbortSignal {
    const controller = new AbortController();
    const key = rpc?.method === 'tools/call' ? requestKey(caller, rpc.id) : undefined;
    if (key) {
      const pending = this.active.get(key) ?? new Set<AbortController>();
      pending.add(controller); this.active.set(key, pending);
    }
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
      const pending = key ? this.active.get(key) : undefined;
      pending?.delete(controller);
      if (key && pending?.size === 0) this.active.delete(key);
    });
    return controller.signal;
  }
}
