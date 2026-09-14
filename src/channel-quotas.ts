import { PROVIDERS, type KeyPublic } from '../shared/types';

export function channelQuotas(keys: KeyPublic[]) {
  return PROVIDERS.flatMap(provider => {
    const channel = keys.filter(key => key.provider === provider);
    if (!channel.length) return [];
    const known = channel.filter(key => key.usage?.status === 'ok' && (key.usage.account || key.usage.balance || key.usage.request_quota || key.usage.money_balance || key.usage.organization_balance || key.usage.local_balance));
    const scopes = new Map<string, KeyPublic>();
    // An explicitly selected manual baseline takes precedence over an old official snapshot for that team.
    for (const key of [...known].sort((a, b) => Number(!!a.usage!.local_balance) - Number(!!b.usage!.local_balance) || a.usage!.synced_at.localeCompare(b.usage!.synced_at))) scopes.set(key.usage!.local_balance?.scope || key.usage!.balance?.scope || key.usage!.request_quota?.scope || key.usage!.money_balance?.scope || key.usage!.organization_balance?.scope || key.id, key);
    const unique = [...scopes.values()];
    const credits = unique.filter(key => !key.usage!.money_balance && !key.usage!.organization_balance && !key.usage!.local_balance);
    const organizations = unique.map(key => key.usage!.organization_balance).filter(balance => !!balance);
    const prepaid = organizations.filter(balance => !balance.postpaid);
    const organizationTotals = organizations.length ? { credits: prepaid.reduce((sum, b) => sum + b.credits_cents, 0), pending: prepaid.reduce((sum, b) => sum + b.pending_debit_cents, 0), prepaid: prepaid.length, postpaid: organizations.length - prepaid.length } : null;
    const money = unique.map(key => key.usage!.money_balance).filter(balance => !!balance);
    const manual = unique.map(key => key.usage!.local_balance).filter(balance => !!balance);
    const manualTotal = manual.reduce((sum, balance) => sum + balance.remaining_usd * 100, 0);
    const moneyTotals = money.length ? money.reduce((sum, balance) => ({ credits: sum.credits + balance.credits_cents, debt: sum.debt + balance.invoice_debt_cents, available: sum.available + balance.available_cents }), { credits: 0, debt: 0, available: 0 }) : null;
    const totals = credits.length ? credits.reduce((sum, key) => {
      const usage = key.usage!;
      const account = usage.account;
      const balance = usage.balance;
      const quota = usage.request_quota;
      return {
        limit: sum.limit + (quota?.total ?? balance?.free_limit ?? account!.limit),
        used: sum.used + (quota?.used ?? balance?.charged_used ?? account!.used),
        remaining: sum.remaining + (quota?.remaining ?? balance?.free_remaining ?? Math.max(0, account!.limit - account!.used)),
        paygoUsed: sum.paygoUsed + (account?.paygo_used ?? 0),
      };
    }, { limit: 0, used: 0, remaining: 0, paygoUsed: 0 }) : null;
    return [{
      provider, keyCount: channel.length, knownCount: known.length,
      unit: provider === 'exa' || provider === 'parallel' ? 'USD' : provider === 'anysearch' ? '次' : 'credits',
      resetPeriods: [...new Set(unique.map(key => key.usage!.request_quota?.reset_period).filter(Boolean))],
      paidRemaining: unique.some(key => key.usage!.balance) ? unique.reduce((sum, key) => sum + (key.usage!.balance?.paid_remaining ?? 0), 0) : null,
      sharedCount: known.length - unique.length,
      failedCount: channel.filter(key => key.usage_error && !key.exa_balance?.auto_paused).length,
      pausedCount: channel.filter(key => key.exa_balance?.auto_paused).length,
      manualCount: manual.length, manualTotal,
      oldestSnapshot: known.map(key => key.usage!.synced_at).sort()[0] || null,
      totals, moneyTotals, organizationTotals,
    }];
  });
}
