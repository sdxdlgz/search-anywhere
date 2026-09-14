import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { KeyPublic } from '../../shared/types';
import type { RunAction } from '../App';
import { api, date, json } from '../api';
import { External, Modal, providerName, Spinner } from '../components';

export function ProviderLogin({ credential, run, onClose }: { credential: KeyPublic; run: RunAction; onClose: () => void }) {
  const name = providerName[credential.provider], anysearch = credential.provider === 'anysearch';
  const savedLogin = credential.keenable_login || credential.anysearch_login;
  const sessionPath = `/keys/${credential.id}/${credential.provider}-session`;
  const [access, setAccess] = useState(''), [refresh, setRefresh] = useState('');
  const [configured, setConfigured] = useState(!!savedLogin), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title={`${name} 登录凭证`} subtitle={`${credential.label} · ${credential.account}`} onClose={onClose}>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      const ok = await run(async () => {
        try {
          if (refresh.trim()) {
            await api(sessionPath, { method: 'PUT', body: json({ ...(access.trim() ? { access_token: access.trim() } : {}), refresh_token: refresh.trim() }) });
            setConfigured(true); setAccess(''); setRefresh('');
          }
          await api(`/keys/${credential.id}/usage`, { method: 'POST' });
        } catch (e) { setError((e as Error).message); throw e; }
      }, `${name} 登录凭证已保存，官方额度已刷新`);
      if (!ok) await run(async () => {}, '');
      setBusy(false); if (ok) onClose();
    }}>
      <div className="modal-body">
        <p>用于查询这个 key 对应账号的官方{anysearch ? '请求额度' : '余额'}。查询时自动续期，替换后的凭证会加密保存。</p>
        {configured && <div className="notice subtle"><ShieldCheck size={16}/><span>{savedLogin?.needs_login ? '登录需要更新；旧额度快照仍保留。' : '已配置登录凭证；留空保留原值。'}{savedLogin && Date.parse(savedLogin.expires_at) > 0 && <small className="cell-sub">上次读取的 access token 到期时间：{date(savedLogin.expires_at)}</small>}</span></div>}
        <label className="field">Access token（可选）<input type="password" value={access} onChange={e => setAccess(e.target.value)} maxLength={16384} autoComplete="new-password" spellCheck={false} placeholder="可留空，由 refresh token 自动获取" disabled={busy}/></label>
        <label className="field">Refresh token<input type="password" value={refresh} onChange={e => setRefresh(e.target.value)} maxLength={4096} autoComplete="new-password" spellCheck={false} placeholder={configured ? '留空保留；更新时填写新的 refresh token' : '粘贴此账号的 refresh token'} required={!configured || !!access.trim()} disabled={busy}/></label>
        <details className="advanced"><summary>从哪里获取登录凭证？</summary>{anysearch ? <p>登录 <External href="https://www.anysearch.com/console/overview">AnySearch 官网</External>，按 F12 → Application → Local Storage → www.anysearch.com，找到 search-template-auth-state，展开 state，读取 accessToken 和 refreshToken。</p> : <p>登录 <External href="https://app.keenable.ai">Keenable 官网</External>，按 F12 → Application → Local Storage → app.keenable.ai，找到 sb-…-auth-token，读取 access_token 和 refresh_token。</p>}<p>建议用单独的浏览器登录会话供网关使用，取出凭证后关闭该官网页面；浏览器与网关同时续期可能让旧 refresh token 失效。不要点击官网退出登录，否则该会话可能被撤销。</p></details>
        {error && <div className="notice warn" role="alert">{error}</div>}
      </div>
      <div className="modal-footer">
        {configured && <button type="button" className="button danger" disabled={busy} onClick={async () => { setBusy(true); const ok = await run(() => api(sessionPath, { method: 'DELETE' }), '官网登录凭证已移除，搜索 key 保留'); setBusy(false); if (ok) onClose(); }}>移除登录凭证</button>}
        <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="button primary" disabled={busy}>{busy && <Spinner/>}{anysearch ? '保存并查询额度' : '保存并查询余额'}</button>
      </div>
    </form>
  </Modal>;
}
