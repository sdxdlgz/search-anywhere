import { useState, type FormEvent } from 'react';
import { Archive, Download, FileUp, ShieldCheck } from 'lucide-react';
import type { BackupPreview, BackupSummary } from '../../shared/types';
import { json, number } from '../api';
import { providerName, Spinner } from '../components';
import type { Provider } from '../../shared/types';
import { HistoryRetention } from './HistoryRetention';

async function checked(response: Response) {
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || '备份操作失败，请稍后重试。'); }
  return response;
}
function uploadBody(file: File, password: string, confirmation_token?: string): Blob {
  const header = new TextEncoder().encode(JSON.stringify({ password, confirmation_token }));
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, header.length);
  return new Blob([size, header, file], { type: 'application/octet-stream' });
}
function Summary({ value }: { value: BackupSummary }) {
  return <div className="grid gap-4 rounded-lg border border-[#e5e8e0] bg-[#f7f8f3] p-5 text-sm">
    <p className="text-muted">备份于 {new Date(value.created_at).toLocaleString('zh-CN')} · 格式 v{value.format_version}</p>
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">{[['供应商 key', value.keys], ['官网登录凭证', value.login_sessions], ['搜索预设', value.profiles], ['搜索访问凭证', value.access_tokens], ['上游调用记录', value.calls], ['结果集合', value.collections]].map(([label, count]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="mt-1 text-xl font-semibold">{number(Number(count))}</dd></div>)}</dl>
    <p className="text-muted">{Object.entries(value.providers).filter(([, count]) => count).map(([provider, count]) => `${providerName[provider as Provider]} ${count}`).join(' · ') || '备份中尚无供应商 key'}</p>
  </div>;
}
export function Backups({ reload }: { reload: () => Promise<void> }) {
  const [exportPassword, setExportPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [restores, setRestores] = useState(0);
  const clearPreview = () => { setPreview(null); setConfirmed(false); setError(''); setMessage(''); };
  const perform = async (action: string, work: () => Promise<void>) => {
    setBusy(action); setError(''); setMessage('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const exportData = (event: FormEvent) => {
    event.preventDefault();
    if (exportPassword !== repeat) { setError('两次输入的备份密码不一致。'); return; }
    void perform('export', async () => {
      const response = await checked(await fetch('/api/backups/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ password: exportPassword }) }));
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `search-anywhere-${new Date().toISOString().slice(0, 10)}.sab`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setExportPassword(''); setRepeat('');
      setMessage('加密备份已生成并开始下载。请妥善保存文件和备份密码。');
    });
  };
  const importData = (action: 'preview' | 'restore') => {
    if (!file) { setError('请选择 .sab 备份文件。'); return; }
    if (file.size > 64 * 1024 * 1024) { setError('备份文件超过 64 MiB，请使用数据目录迁移。'); return; }
    void perform(action, async () => {
      const response = await checked(await fetch(`/api/backups/${action}`, { method: 'POST', body: uploadBody(file, password, action === 'restore' ? preview?.confirmation_token : undefined) }));
      if (action === 'preview') { setPreview(await response.json()); setConfirmed(false); return; }
      setPreview(null); setConfirmed(false); setPassword('');
      setRestores(value => value + 1);
      setMessage('恢复完成。当前管理员口令保持不变，搜索访问凭证、配置和历史记录已恢复。');
      try { await reload(); } catch { throw new Error('数据已恢复，但页面刷新失败，请刷新浏览器查看。'); }
    });
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">BACKUP & MIGRATION</div><h1>备份与迁移<span>.</span></h1><p>把搜索工作台完整带到新的服务器。</p></div><span className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-[#e5e8e0] px-3 py-2 text-xs text-muted"><ShieldCheck size={14}/>加密备份</span></div>
    <div className="notice subtle"><Archive size={18}/><span>包含 key、账号备注、官网登录凭证、额度快照、预设、搜索访问凭证和当前保留的历史结果。VPS 的管理员口令和服务器配置保持不变。</span></div>
    {error && <div role="alert" className="notice warn">{error}</div>}{message && <div role="status" className="notice subtle">{message}</div>}
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <section className="panel p-6"><div className="mb-6"><h2 className="mb-2 flex items-center gap-2"><Download size={19}/>导出备份</h2><p className="text-muted">下载一个 .sab 文件，凭备份密码可在另一台 Search Anywhere 恢复。密码无法找回。</p></div>
        <form onSubmit={exportData} className="grid gap-4"><label className="field">设置备份密码<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={exportPassword} onChange={e => setExportPassword(e.target.value)} disabled={!!busy}/></label>
          <label className="field">再次输入备份密码<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={repeat} onChange={e => setRepeat(e.target.value)} disabled={!!busy}/></label>
          <p className="text-xs text-muted">至少 12 个字符。导出包含完整历史；文件上限 64 MiB，解压后上限 256 MiB。</p>
          <button className="button primary justify-center" disabled={!!busy}>{busy === 'export' ? <Spinner/> : <Download size={16}/>}下载加密备份</button>
        </form>
      </section>
      <section className="panel p-6"><div className="mb-6"><h2 className="mb-2 flex items-center gap-2"><FileUp size={19}/>导入备份</h2><p className="text-muted">先预览内容，再确认替换当前数据。恢复前建议先导出本机备份。</p></div>
        <form className="grid gap-4" onSubmit={e => { e.preventDefault(); importData('preview'); }}>
          <label className="field">选择备份文件<input type="file" accept=".sab,application/octet-stream" required disabled={!!busy} onChange={e => { setFile(e.target.files?.[0] || null); clearPreview(); }}/></label>
          <label className="field">输入备份密码<input type="password" autoComplete="off" minLength={12} maxLength={256} required value={password} disabled={!!busy} onChange={e => { setPassword(e.target.value); clearPreview(); }}/></label>
          <button className="button justify-center" disabled={!!busy || !file}>{busy === 'preview' ? <Spinner/> : <FileUp size={16}/>}预览备份</button>
        </form>
        {preview && <div className="mt-6 grid gap-4"><Summary value={preview.summary}/><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={!!busy} onChange={e => setConfirmed(e.target.checked)}/><span>我已备份当前数据，并确认用这份备份替换当前的 key、配置、访问凭证和历史记录。</span></label><button className="button primary justify-center" disabled={!!busy || !confirmed} onClick={() => importData('restore')}>{busy === 'restore' ? <Spinner/> : <Archive size={16}/>}确认替换并恢复</button></div>}
      </section>
    </div>
    <p className="mt-6 text-sm text-muted">迁移到 VPS：完成导出后停止旧实例，再在 VPS 导入，避免两端同时续期同一组登录凭证。备份操作需要等待正在执行的搜索和余额查询结束。超过网页上限时，可停机后整体复制数据目录。</p>
    <HistoryRetention key={restores} reload={reload}/>
  </>;
}
