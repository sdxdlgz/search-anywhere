import { useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import type { KeyPublic, ParallelAuthorization, ParallelAuthPoll } from '../../shared/types';
import type { RunAction } from '../App';
import { api, date } from '../api';
import { CopyButton, Modal, Spinner } from '../components';

export function ParallelLogin({ credential, run, onClose }: { credential: KeyPublic; run: RunAction; onClose: () => void }) {
  const [flow, setFlow] = useState<ParallelAuthorization | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [polling, setPolling] = useState(true);
  const current = useRef<ParallelAuthorization | null>(null), alive = useRef(true);
  const base = `/keys/${credential.id}/parallel-auth`;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (current.current) void api(`${base}/${current.current.id}`, { method: 'DELETE' }).catch(() => undefined); };
  }, [base]);
  useEffect(() => {
    if (!flow || !polling) return;
    const timer = setTimeout(async () => {
      try {
        const result = await api<ParallelAuthPoll>(`${base}/${flow.id}/poll`, { method: 'POST' });
        if (!alive.current) return;
        if (result.status === 'pending') { setFlow({ ...flow, poll_after_seconds: result.poll_after_seconds }); return; }
        current.current = null; setFlow(null); setBusy(true);
        // Balance failures remain visible in the key's usage_error after reloading.
        await run(async () => { await api(`/keys/${credential.id}/usage`, { method: 'POST' }).catch(() => undefined); }, 'Parallel 授权已保存；余额查询结果已更新');
        if (alive.current) onClose();
      } catch (e) { if (alive.current) { setError((e as Error).message); setPolling(false); } }
    }, flow.poll_after_seconds * 1000);
    return () => clearTimeout(timer);
  }, [flow, polling, base, credential.id, run, onClose]);
  const start = async () => {
    setBusy(true); setError('');
    try {
      if (current.current) await api(`${base}/${current.current.id}`, { method: 'DELETE' });
      const next = await api<ParallelAuthorization>(base, { method: 'POST' });
      if (!alive.current) { await api(`${base}/${next.id}`, { method: 'DELETE' }); return; }
      current.current = next; setFlow(next); setPolling(true);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  };
  const login = credential.parallel_login;
  return <Modal title="Parallel 余额授权" subtitle={`${credential.label} · ${credential.masked}`} onClose={onClose}>
    <div className="modal-body">
      <div className="notice subtle"><KeyRound size={18}/><span>通过官网授权读取组织余额，凭证自动加密保存并续期。仅申请余额读取权限；匿名免费 MCP 无需授权。</span></div>
      <p>授权时请选择这把 key 所属的组织。官方接口确认授权组织，无法自动反查现有搜索 key 的归属；同组织的余额只汇总一次。</p>
      {login && <div className="saved-secret"><KeyRound size={16}/><div><strong>{login.needs_login ? '需要重新授权' : '已保存余额授权'}</strong><small className="cell-sub">{login.org_name || '已授权组织'} · {login.org_id}</small><small className="cell-sub">Access token 到期 {date(login.expires_at)} · 自动续期</small></div></div>}
      {flow && <section className="panel" aria-label="Parallel 官网授权步骤"><div className="modal-body"><strong>在官网确认授权</strong><p>授权码 <code>{flow.user_code}</code> <CopyButton value={flow.user_code} label="复制授权码"/></p><a className="button primary" href={flow.verification_uri} target="_blank" rel="noopener noreferrer">打开 Parallel 官网<ExternalLink size={16}/></a><small className="cell-sub">有效至 {date(flow.expires_at)}；确认后自动保存。</small><p aria-live="polite">{polling ? <><Spinner/>等待官网授权…</> : '授权检查已暂停，可重试或重新开始。'}</p></div></section>}
      {error && <div className="notice warn" role="alert">{error}</div>}
    </div>
    <div className="modal-footer">
      {login && !flow && <button className="button danger" disabled={busy} onClick={async () => { setBusy(true); if (await run(() => api(`/keys/${credential.id}/parallel-session`, { method: 'DELETE' }), '已移除本地余额授权，搜索 key 保留')) onClose(); else setBusy(false); }}><Trash2 size={15}/>移除本地授权</button>}
      <button className="button" onClick={onClose}>{flow ? '取消授权' : '关闭'}</button>
      {flow && !polling && <button className="button" onClick={() => { setError(''); setPolling(true); }}>重试检查</button>}
      <button className="button primary" disabled={busy || (!!flow && polling)} onClick={() => void start()}>{busy && <Spinner/>}{flow ? '重新开始' : login ? '重新官网授权' : '开始官网授权'}</button>
    </div>
  </Modal>;
}
