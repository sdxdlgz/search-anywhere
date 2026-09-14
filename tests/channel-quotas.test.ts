import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture } from './helpers.js';
import { channelQuotas } from '../src/channel-quotas.js';
import { ChannelQuotas } from '../src/pages/ChannelQuotas.js';
import type { UsageSnapshot } from '../shared/types.js';
import { Usage } from '../src/components.js';
import { exaBalanceSnapshot } from '../server/exa-balance.js';
import { exaCredits, exaPlan } from './exa-fixtures.js';

const quota = (used = 0, limit = 1000): UsageSnapshot => ({ status: 'ok', source: 'official', synced_at: '2026-09-14T00:00:00.000Z', account: { plan: 'Free', used, limit, paygo_used: 0, paygo_limit: null } });

test('E3/E5: Exa sums dollars by verified team, keeps debt and expiry separate and never infers lifetime allowance', async () => {
  const f = fixture();
  try {
    const keys = f.add('exa', 'same source', ['exa-money-a12345', 'exa-money-b12345', 'exa-money-c12345', 'exa-money-unknown']);
    for (const [i, key] of keys.slice(0, 3).entries()) f.store.setUsage(key.id, { ...exaBalanceSnapshot({ ...exaCredits, orbInvoiceDebt: i * 100 }, exaPlan, i < 2 ? 'same-team' : 'other-team'), synced_at: `2026-09-14T0${i}:00:00.000Z` });
    const [channel] = channelQuotas(f.store.keys());
    assert.equal(channel.unit, 'USD'); assert.equal(channel.sharedCount, 1); assert.equal(channel.totals, null);
    assert.deepEqual(channel.moneyTotals, { credits: 4000, debt: 300, available: 3700 });
    const html = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.match(html, /\$37.00/); assert.match(html, /1 个 key 的额度未知/); assert.doesNotMatch(html, /credits|总额度|套餐已用|same-team|same source/);
    const cell = renderToStaticMarkup(createElement(Usage, { usage: f.store.keys()[0].usage, error: null }));
    assert.match(cell, /官网余额 \$20.00/); assert.match(cell, /\$10.00 到期于/); assert.match(cell, /2026/); assert.doesNotMatch(cell, /本月已用费用/);
  } finally { await f.cleanup(); }
});

test('A3: AnySearch uses requests and exact official remaining, deduplicates accounts and displays mixed reset cycles', async () => {
  const f = fixture();
  try {
    const keys = f.add('anysearch', 'same source', ['any-quota-a12345', 'any-quota-b12345', 'any-quota-c12345']);
    for (const [i, key] of keys.entries()) f.store.setUsage(key.id, { status: 'ok', source: 'official', synced_at: `2026-09-14T0${i}:00:00.000Z`, request_quota: { total: 1000, used: i, remaining: 900, scope: i < 2 ? 'same-account' : 'other-account', tier: 'Free', reset_period: i < 2 ? 'daily' : 'monthly', next_reset_at: null, key_used: 0, key_limit: null, total_calls: null, month_calls: null } });
    const [channel] = channelQuotas(f.store.keys());
    assert.equal(channel.unit, '次'); assert.equal(channel.sharedCount, 1); assert.equal(channel.paidRemaining, null);
    assert.deepEqual(channel.totals, { limit: 2000, used: 3, remaining: 1800, paygoUsed: 0 });
    const html = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.match(html, /2,000/); assert.match(html, /各账号按各自周期重置/); assert.doesNotMatch(html, /credits|same-account|same source/);
    const cell = renderToStaticMarkup(createElement(Usage, { usage: f.store.keys()[0].usage, error: null }));
    assert.match(cell, /官方剩余 900 次/); assert.match(cell, /每日重置/); assert.doesNotMatch(cell, /credits|官方累计调用/);
  } finally { await f.cleanup(); }
});

test('K3/K5: Keenable free and paid credits stay separate; verified shared organizations count once using the newest snapshot', async () => {
  const f = fixture();
  try {
    const keys = f.add('keenable', 'same note', ['keen-quota-a12345', 'keen-quota-b12345', 'keen-quota-c12345']);
    for (const [i, key] of keys.entries()) f.store.setUsage(key.id, { status: 'ok', source: 'official', synced_at: `2026-09-14T0${i}:00:00.000Z`, balance: { scope: i < 2 ? 'shared-official-org' : 'other-org', free_limit: 100000, charged_used: i, free_remaining: 100000 - i, paid_remaining: 50 } });
    const [tavily] = f.add('tavily'); f.store.setUsage(tavily.id, quota());
    const channel = channelQuotas(f.store.keys()).find(c => c.provider === 'keenable')!;
    assert.equal(channel.knownCount, 3); assert.equal(channel.sharedCount, 1);
    assert.deepEqual(channel.totals, { limit: 200000, used: 3, remaining: 199997, paygoUsed: 0 });
    assert.equal(channel.paidRemaining, 100);
    const html = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.match(html, /付费余额 100 credits（另计）/); assert.match(html, /免费总额度/);
    assert.doesNotMatch(html, /same note|shared-official-org/);
  } finally { await f.cleanup(); }
});

test('Q1: twelve independent accounts with the same source note contribute twelve quotas to Tavily alone', async () => {
  const f = fixture();
  try {
    const keys = f.add('tavily', 'same-source-note', Array.from({ length: 12 }, (_, i) => `quota-credential-${i}-12345678`));
    keys.forEach((key, i) => f.store.setUsage(key.id, quota(i === 0 ? 1 : 0)));
    const [exa] = f.add('exa', 'same-source-note');
    f.store.setUsage(exa.id, { status: 'ok', source: 'official', synced_at: quota().synced_at, cost_usd: 2 });
    const channels = channelQuotas(f.store.keys());
    assert.equal(channels.length, 2);
    const tavily = channels.find(c => c.provider === 'tavily')!;
    assert.equal(tavily.knownCount, 12); assert.equal(tavily.keyCount, 12);
    assert.deepEqual(tavily.totals, { limit: 12000, used: 1, remaining: 11999, paygoUsed: 0 });
    assert.equal(channels.find(c => c.provider === 'exa')!.totals, null);
    const html = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.equal((html.match(/class="channel-quota-row"/g) || []).length, 2);
    assert.match(html, /12,000/); assert.match(html, /11,999/); assert.doesNotMatch(html, /same-source-note/);
  } finally { await f.cleanup(); }
});

test('Q2: partial quotas preserve zero and failed snapshots, exclude unknowns and clamp remaining per account', async () => {
  const f = fixture();
  try {
    const [a, b, c, d] = f.add('tavily', 'note', ['quota-a-12345678', 'quota-b-12345678', 'quota-c-12345678', 'quota-d-12345678']);
    f.store.setUsage(a.id, quota(2, 0)); f.store.usageError(a.id, 'query failed');
    f.store.setUsage(b.id, { ...quota(1), synced_at: '2026-09-14T01:00:00.000Z', account: { ...quota(1).account!, paygo_used: 5 } });
    f.store.usageError(c.id, 'no previous snapshot');
    f.store.setUsage(d.id, { ...quota(), status: 'unsupported', source: 'unknown' });
    const [channel] = channelQuotas(f.store.keys());
    assert.equal(channel.knownCount, 2); assert.equal(channel.failedCount, 2);
    assert.equal(channel.oldestSnapshot, quota().synced_at);
    assert.deepEqual(channel.totals, { limit: 1000, used: 3, remaining: 999, paygoUsed: 5 });
    const html = renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} }));
    assert.match(html, /已知总额度/); assert.match(html, /2 个 key 的额度未知/); assert.match(html, /2 个查询失败/); assert.match(html, /按量已用 5 credits（另计）/);
    f.store.deleteKey(a.id); f.store.deleteKey(b.id);
    assert.equal(channelQuotas(f.store.keys())[0].totals, null);
  } finally { await f.cleanup(); }
});

test('Q2/Q3: empty and unsynced channels never imply zero official quota', async () => {
  assert.deepEqual(channelQuotas([]), []);
  assert.match(renderToStaticMarkup(createElement(ChannelQuotas, { keys: [], onAdd() {} })), /连接你的第一个搜索渠道/);
  const f = fixture();
  try {
    const [key] = f.add('tavily');
    assert.match(renderToStaticMarkup(createElement(ChannelQuotas, { keys: f.store.keys(), onAdd() {} })), /尚无已同步的套餐额度/);
    f.store.setUsage(key.id, quota(0, 0));
    assert.deepEqual(channelQuotas(f.store.keys())[0].totals, { limit: 0, used: 0, remaining: 0, paygoUsed: 0 });
  } finally { await f.cleanup(); }
});
