import type { KeyPublic } from '../../shared/types';
import { date, number, usd } from '../api';
import { channelQuotas } from '../channel-quotas';
import { Empty, ProviderMark, providerName } from '../components';

export function ChannelQuotas({ keys, onAdd }: { keys: KeyPublic[]; onAdd: () => void }) {
  const channels = channelQuotas(keys);
  return <section className="panel channel-quota-panel" aria-label="渠道额度">
    <div className="panel-heading"><div><h2>渠道额度</h2><p>按渠道累计已知额度；来源备注不参与计算，官网登录接口确认的共享额度仅累计一次。</p></div><span className="counter">{channels.length} 个渠道</span></div>
    {!channels.length ? <Empty title="连接你的第一个搜索渠道" onAdd={onAdd}>添加密钥，即可汇总各渠道额度。</Empty> : <div>{channels.map(channel => <div className="channel-quota-row" key={channel.provider}>
      <div className="channel-quota-name"><ProviderMark provider={channel.provider}/><div><strong>{providerName[channel.provider]}</strong><small>{channel.keyCount} 个 key · 已知额度 {channel.knownCount} / {channel.keyCount}</small></div></div>
      {channel.organizationTotals ? <dl className="channel-quota-values">
        <div><dt>授权组织预付余额</dt><dd>{channel.organizationTotals.prepaid ? <>{usd(channel.organizationTotals.credits)} <small>USD</small></> : '后付费'}</dd></div>
        <div><dt>待扣 / 占用（单列）</dt><dd>{channel.organizationTotals.prepaid ? usd(channel.organizationTotals.pending) : '按账单结算'}</dd></div>
        <div><dt>计费组织</dt><dd>{channel.organizationTotals.prepaid} <small>预付 · {channel.organizationTotals.postpaid} 后付</small></dd></div>
      </dl> : channel.moneyTotals ? <dl className="channel-quota-values">
        <div><dt>官网余额</dt><dd>{usd(channel.moneyTotals.available)} <small>USD</small></dd></div>
        <div><dt>账面额度</dt><dd>{usd(channel.moneyTotals.credits)}</dd></div>
        <div><dt>未结算账单</dt><dd>{usd(channel.moneyTotals.debt)}</dd></div>
      </dl> : channel.totals ? <dl className="channel-quota-values">
        <div><dt>{channel.provider === 'keenable' ? '免费总额度' : channel.knownCount < channel.keyCount ? '已知总额度' : '总额度'}</dt><dd>{number(channel.totals.limit)} <small>{channel.unit}</small></dd></div>
        <div><dt>{channel.provider === 'keenable' ? '已计费消耗' : channel.provider === 'anysearch' ? '额度已用' : '套餐已用'}</dt><dd>{number(channel.totals.used)}</dd></div>
        <div><dt>{channel.provider === 'keenable' ? '免费剩余' : channel.provider === 'anysearch' ? '官方剩余' : '套餐剩余'}</dt><dd>{number(channel.totals.remaining)}</dd></div>
      </dl> : <div className="text-muted channel-quota-unknown">{channel.provider === 'tavily' ? '尚无已同步的套餐额度' : '官方额度未知'}</div>}
      <div className="channel-quota-foot">
        <span>{channel.oldestSnapshot ? `最早快照 ${date(channel.oldestSnapshot)}` : '在密钥页面查询用量'}{channel.totals && channel.totals.paygoUsed > 0 ? ` · 按量已用 ${number(channel.totals.paygoUsed)} credits（另计）` : ''}</span>
        {channel.paidRemaining !== null && <span>付费余额 {number(channel.paidRemaining)} credits（另计）</span>}
        {channel.sharedCount > 0 && <span>{channel.sharedCount} 份共享额度未重复累计</span>}
        {channel.resetPeriods.length > 0 && <span>{channel.resetPeriods.length > 1 ? '各账号按各自周期重置' : channel.resetPeriods[0] === 'daily' ? '每日重置' : channel.resetPeriods[0] === 'monthly' ? '每月重置' : '无定期重置'}</span>}
        <span className={channel.failedCount ? 'text-warn' : ''}>{channel.knownCount < channel.keyCount ? `${channel.keyCount - channel.knownCount} 个 key 的额度未知` : ''}{channel.failedCount ? ` · ${channel.failedCount} 个查询失败，已有快照暂保留` : ''}</span>
      </div>
    </div>)}</div>}
  </section>;
}
