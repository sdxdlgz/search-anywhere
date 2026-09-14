import { useEffect, useState } from 'react';
import { Clock3, RefreshCw, Trash2 } from 'lucide-react';
import type { CleanupPreview, CleanupResult, RetentionStatus } from '../../shared/types';
import { api, json, number } from '../api';
import { Spinner } from '../components';

const size = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
const time = (value: string) => new Date(value).toLocaleString('zh-CN');

export function HistoryRetention({ reload }: { reload: () => Promise<void> }) {
  const [status, setStatus] = useState<RetentionStatus | null>(null), [enabled, setEnabled] = useState(true), [days, setDays] = useState('7');
  const [range, setRange] = useState('policy'), [preview, setPreview] = useState<CleanupPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { let cancelled = false; void api<RetentionStatus>('/retention').then(value => {
    if (!cancelled) { setStatus(value); setEnabled(value.policy.enabled); setDays(String(value.policy.days)); }
  }).catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(timer); }, [message]);
  const perform = async (action: string, task: () => Promise<void>) => {
    setBusy(action); setError(''); setMessage('');
    try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const resetPreview = () => { setPreview(null); setConfirmed(false); };
  const refresh = async () => { const value = await api<RetentionStatus>('/retention'); setStatus(value); setEnabled(value.policy.enabled); setDays(String(value.policy.days)); return value; };
  const clean = () => void perform('clean', async () => {
    if (!preview) return;
    const { cutoff, expires_at, confirmation_token } = preview;
    resetPreview();
    const result = await api<CleanupResult>('/retention/clean', { method: 'POST', body: json({ cutoff, expires_at, confirmation_token }) });
    setMessage(`已清理 ${number(result.requests)} 条搜索日志、${number(result.collections)} 个结果集合和 ${number(result.call_details)} 条调用明细。`);
    try { await refresh(); await reload(); } catch { throw new Error('清理已完成，但页面刷新失败，请刷新页面查看。'); }
  });
  return <section className="panel mt-6 p-6" aria-labelledby="retention-heading">
    <div className="mb-4 flex items-start justify-between gap-4"><div><h2 id="retention-heading" className="mb-2 flex items-center gap-2"><Trash2 size={19}/>历史数据清理</h2><p className="text-muted">定期清理搜索词、结果、正文和调用日志内容，控制历史数据占用。</p></div><button className="icon-button" aria-label="刷新存储统计" disabled={!!busy} onClick={() => void perform('refresh', async () => { await refresh(); resetPreview(); })}><RefreshCw size={16}/></button></div>
    {error && <div role="alert" className="notice warn">{error}</div>}{message && <div role="status" className="notice subtle">{message}</div>}
    {status && <>
      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">{[['搜索日志', number(status.retained.requests)], ['结果集合', number(status.retained.collections)], ['数据库 / WAL', `${size(status.storage.database_bytes)} / ${size(status.storage.wal_bytes)}`], ['可复用空闲空间', size(status.storage.reusable_bytes)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-2 text-lg font-semibold">{value}</dd></div>)}</dl>
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <form className="grid gap-4" onSubmit={e => { e.preventDefault(); void perform('save', async () => {
          const value = await api<RetentionStatus>('/retention', { method: 'PUT', body: json({ enabled, days: Number(days) }) });
          setStatus(value); resetPreview(); await reload(); setMessage('清理策略已保存。');
        }); }}>
          <h3 className="flex items-center gap-2"><Clock3 size={16}/>自动清理</h3>
          <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={!!busy}/>启用自动清理</label>
          <label className="field">自动保留天数<input type="number" min={1} max={3650} step={1} required value={days} onChange={e => setDays(e.target.value)} disabled={!!busy}/></label>
          <p className="text-xs text-muted">默认开启并保留最近 7 天。每天清理一次；忙碌时延后，每分钟检查。关闭自动清理仍可手动操作。</p>
          <button className="button justify-center" disabled={!!busy}>{busy === 'save' && <Spinner/>}保存清理策略</button>
        </form>
        <div className="grid gap-4"><h3>手动清理</h3>
          <label className="field">手动清理范围<select value={range} onChange={e => { setRange(e.target.value); resetPreview(); }} disabled={!!busy}><option value="policy">保留最近 {status.policy.days} 天（已保存的策略）</option><option value="7">保留最近 7 天</option><option value="30">保留最近 30 天</option><option value="90">保留最近 90 天</option><option value="0">清空现有历史内容</option></select></label>
          <p className="text-xs text-muted">仅清理预览截止时间之前的内容。该操作不可撤销，需要的资料请先导出备份。</p>
          <button className="button justify-center" disabled={!!busy} onClick={() => void perform('preview', async () => {
            resetPreview(); setPreview(await api<CleanupPreview>('/retention/preview', { method: 'POST', body: json({ days: range === 'policy' ? status.policy.days : Number(range) }) }));
          })}>{busy === 'preview' ? <Spinner/> : <Trash2 size={16}/>}预览清理范围</button>
          {preview && <div className="grid gap-4 rounded-lg border border-[#e5e8e0] bg-[#f7f8f3] p-4 text-sm"><p>清理 {time(preview.cutoff)} 之前的内容。</p><p>{number(preview.requests)} 条搜索日志 · {number(preview.collections)} 个结果集合 · {number(preview.call_details)} 条调用明细<br/>内容大小约 {size(preview.content_bytes)}，不等于磁盘缩小量。</p>
            {preview.requests + preview.collections + preview.call_details ? <><label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={!!busy}/><span>确认删除以上历史内容，已保存需要保留的资料。</span></label><button className="button primary justify-center" disabled={!!busy || !confirmed} onClick={clean}>{busy === 'clean' ? <Spinner/> : <Trash2 size={16}/>}确认清理历史内容</button></> : <p className="text-muted">当前没有符合条件的内容。</p>}
            <button className="button small justify-center" disabled={!!busy} onClick={resetPreview}>取消预览</button>
          </div>}
        </div>
      </div>
      <div className="mt-6 grid gap-2 border-t border-[#e5e8e0] pt-4 text-xs text-muted"><p>当前策略：{status.policy.enabled ? `自动保留 ${status.policy.days} 天` : '自动清理已关闭'}。{status.next_cleanup_at && `下次检查：${time(status.next_cleanup_at)}，忙碌时顺延。`}</p>
        {status.last_cleanup && <p>最近清理：{time(status.last_cleanup.completed_at)}（{status.last_cleanup.source === 'automatic' ? '自动' : '手动'}），清理 {number(status.last_cleanup.requests)} 条搜索日志、{number(status.last_cleanup.collections)} 个集合、{number(status.last_cleanup.call_details)} 条调用明细。</p>}
        {status.last_error && <p role="alert" className="text-warn">{status.last_error}</p>}
        <p>key、账号备注、登录授权和额度快照保持不变；精简计费记录持续保留，用于累计／月用量、每日上限和手动余额。清理后的集合无法再分页或读取正文。</p><p>释放的数据库页面供后续写入复用，数据库文件通常不会立即变小。计费记录仍会缓慢增长；已导出的备份和容器日志需另行管理。</p>
      </div>
    </>}
  </section>;
}
