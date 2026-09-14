import type { TokenUsagePeriod } from '../../shared/types';
import { number } from '../api';
import { providerName } from '../components';

const amount = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 6 });
const dollars = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });

export function ClientTokenUsage({ usage }: { usage?: TokenUsagePeriod }) {
  if (!usage) return <><td>—</td><td>统计暂不可用</td></>;
  return <>
    <td><strong>{number(usage.requests)} 次请求</strong><small className="cell-sub">上游调用 {number(usage.upstream_calls)} 次 · 缓存 {number(usage.cache_hits)} 次</small>
      {(usage.errors > 0 || usage.partial > 0 || usage.running > 0) && <small className="cell-sub">失败 {number(usage.errors)} · 部分成功 {number(usage.partial)} · 进行中 {number(usage.running)}</small>}</td>
    <td>
      {usage.reported_cost_usd !== null && <div>{dollars(usage.reported_cost_usd)} <small className="text-muted">上游报告</small></div>}
      {usage.estimated_cost_usd !== null && <div>≈ {dollars(usage.estimated_cost_usd)} <small className="text-muted">估算</small></div>}
      {usage.credits_by_provider.map(c => <div key={c.provider}>{providerName[c.provider]} <span>{c.reported !== null && `${amount(c.reported)} credits`}{c.reported !== null && c.estimated !== null && ' + '}{c.estimated !== null && `≈ ${amount(c.estimated)} credits`}</span></div>)}
      {usage.free_calls > 0 && <div className="text-muted">免费调用 {number(usage.free_calls)} 次</div>}
      {usage.unpriced_calls > 0 && <div className="text-muted">费用未知 {number(usage.unpriced_calls)} 次</div>}
      {usage.running_calls > 0 && <div className="text-muted">待结束 {number(usage.running_calls)} 次</div>}
      {usage.upstream_calls === 0 && <span className="text-muted">尚无上游调用</span>}
    </td>
  </>;
}
