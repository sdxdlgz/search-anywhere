import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, LoaderCircle, Network, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { KeyPublic, Provider, UsageSnapshot } from '../shared/types';
import { date, number, usd } from './api';

export function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-mark"><Network size={small ? 20 : 24} strokeWidth={1.8}/></span><span>Search<br/><strong>Anywhere<span className="brand-dot">.</span></strong></span></div>;
}
export function ProviderMark({ provider }: { provider: Provider }) { return <span className={`provider-mark ${provider}`} aria-hidden="true">{{ exa: 'e', parallel: '∥', tavily: 't', anysearch: 'a', keenable: 'k' }[provider]}</span>; }
export const providerName = { exa: 'Exa', parallel: 'Parallel', tavily: 'Tavily', anysearch: 'AnySearch', keenable: 'Keenable' };
export function Badge({ state }: { state: string }) {
  const labels: Record<string, string> = { ready: '可用', disabled: '已停用', invalid: '凭证无效', exhausted: '额度不足', cooldown: '冷却中', success: '成功', partial: '部分成功', error: '失败', running: '执行中' };
  return <span className={`badge ${['ready','success'].includes(state) ? 'good' : ['disabled','running'].includes(state) ? 'muted' : 'warn'}`}><i/>{labels[state] || state}</span>;
}
export function Empty({ title, children, onAdd }: { title: string; children: ReactNode; onAdd?: () => void }) {
  return <div className="empty"><span className="empty-symbol"><Network size={30} strokeWidth={1.3}/></span><h3>{title}</h3><p>{children}</p>{onAdd && <button className="button primary" onClick={onAdd}><Plus size={16}/>添加第一个密钥</button>}</div>;
}
export function Spinner() { return <LoaderCircle className="spin" size={16}/>; }
export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="button small" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }} aria-label={label}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? '已复制' : label}</button>;
}
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog className={`modal ${wide ? 'wide' : ''}`} ref={ref} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}
export function Usage({ usage, error, metering }: { usage: UsageSnapshot | null; error: string | null; metering?: KeyPublic['metering'] }) {
  if (!usage) return <div className="quota-cell"><span className="text-muted">{error ? '同步失败' : '尚未同步'}</span>{error && <small className="text-warn">{error}</small>}</div>;
  const checkedAt = new Date(usage.synced_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (usage.status !== 'ok') return <div className="quota-cell" title={usage.message}><span className="text-muted">{usage.status === 'needs_setup' ? '待配置凭证' : '仅本地统计'}</span><small>{usage.status === 'needs_setup' ? usage.message : '官方额度未知'}</small><small>检查于 {checkedAt}</small>{error && <small className="text-warn">{error}</small>}</div>;
  return <div className="quota-cell" title={`${usage.message || '官方用量'} · ${date(usage.synced_at)}${error ? ' · 最近同步失败，显示旧数据' : ''}`}>
    {usage.key && <><span>官方 key 已用 {number(usage.key.used)} credits</span><small>key 上限 {usage.key.limit === null ? '未提供' : number(usage.key.limit)}{usage.key.limit === null ? '' : ` · 剩余 ${number(Math.max(0, usage.key.limit - usage.key.used))}`}</small></>}
    {usage.account && <><span>账号套餐已用 {number(usage.account.used)} / {number(usage.account.limit)}</span><small>套餐剩余 {number(Math.max(0, usage.account.limit - usage.account.used))} credits · 同账号共享</small><small>按量已用 {number(usage.account.paygo_used)} · 上限 {usage.account.paygo_limit === null ? '未提供' : number(usage.account.paygo_limit)}</small></>}
    {usage.balance && <><span>免费额度 {number(usage.balance.free_limit)} credits</span><small>已计费消耗 {number(usage.balance.charged_used)} · 免费剩余 {number(usage.balance.free_remaining)}</small><small>付费余额 {number(usage.balance.paid_remaining)} credits</small></>}
    {usage.request_quota && <><span>账号额度 {number(usage.request_quota.used)} / {number(usage.request_quota.total)} 次</span><small>官方剩余 {number(usage.request_quota.remaining)} 次 · {{ daily: '每日重置', monthly: '每月重置', none: '无定期重置' }[usage.request_quota.reset_period]}</small><small>key 已用 {number(usage.request_quota.key_used)} 次 · 限额 {usage.request_quota.key_limit === null ? '不限' : `${number(usage.request_quota.key_limit)} 次`}</small>{usage.request_quota.next_reset_at && <small>下次重置 {date(usage.request_quota.next_reset_at)}</small>}{usage.request_quota.total_calls !== null && <small>官方累计调用 {number(usage.request_quota.total_calls)} 次</small>}</>}
    {usage.cost_usd !== undefined && <><span>${usage.cost_usd.toFixed(4)}</span><small>本月已用费用</small></>}
    {usage.organization_balance && <>{usage.organization_balance.postpaid ? <><span>后付费组织</span><small>按账单结算，不以预付余额判断额度</small></> : <><span>授权组织余额 {usd(usage.organization_balance.credits_cents)}</span><small>待扣 / 占用 {usd(usage.organization_balance.pending_debit_cents)}（单列）</small></>}<small>组织额度，不代表此 key 的独立余额</small></>}
    {usage.money_balance && <><span>官网余额 {usd(usage.money_balance.available_cents)}</span><small>账面额度 {usd(usage.money_balance.credits_cents)} · 未结算账单 {usd(usage.money_balance.invoice_debt_cents)}</small>{usage.money_balance.expiring.length > 0 && <details><summary>{usage.money_balance.expiring.length} 笔额度有到期时间（已含在余额中）</summary>{usage.money_balance.expiring.map((entry, i) => <small key={i}>{usd(entry.balance_cents)} 到期于 <time dateTime={entry.expires_at}>{new Date(entry.expires_at).toLocaleString('zh-CN')}</time></small>)}</details>}</>}
    <small>查询于 {checkedAt}</small>
    {usage.key?.used === 0 && (metering?.reported_credits || 0) > 0 && <small className="usage-difference">网关本月已记录 {number(metering?.reported_credits)} credits，官方 key 快照为 0。更新时间或统计范围可能不同。</small>}
    {error && <small className="text-warn">{error} · 显示上次快照</small>}
  </div>;
}
export function External({ href, children }: { href: string; children: ReactNode }) { return <a className="text-link" href={href} target="_blank" rel="noreferrer noopener">{children}<ArrowUpRight size={13}/></a>; }
