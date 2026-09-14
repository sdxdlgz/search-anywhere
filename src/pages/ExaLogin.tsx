import { useState } from 'react';
import type { KeyPublic } from '../../shared/types';
import type { RunAction } from '../App';
import { api, date, json } from '../api';
import { External, Modal, Spinner } from '../components';

export function ExaLogin({ credential, run, onClose }: { credential: KeyPublic; run: RunAction; onClose: () => void }) {
  const saved = credential.exa_login, path = `/keys/${credential.id}/exa-session`;
  const [cookie, setCookie] = useState(''), [team, setTeam] = useState(saved?.team_id || '');
  const [configured, setConfigured] = useState(!!saved), [savedTeam, setSavedTeam] = useState(saved?.team_id || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="Exa 登录凭证" subtitle={`${credential.label} · ${credential.account}`} onClose={onClose}>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      const ok = await run(async () => {
        try {
          if (cookie.trim()) {
            await api(path, { method: 'PUT', body: json({ cookie: cookie.trim(), team_id: team.trim() }) });
            setCookie(''); setConfigured(true); setSavedTeam(team.trim());
          }
          await api(`/keys/${credential.id}/usage`, { method: 'POST' });
        } catch (e) { setError((e as Error).message); throw e; }
      }, 'Exa 官方余额已刷新');
      if (!ok) await run(async () => {}, '');
      setBusy(false); if (ok) onClose();
    }}>
      <div className="modal-body">
        <p>使用官网会话查询团队美元余额，无需 Service Key。保存后会核对 Cookie 当前团队与搜索 key 所属团队。</p>
        {configured && <div className="notice subtle"><span>{saved?.needs_login ? '登录需要更新；已有余额快照仍保留。' : 'Cookie 已加密保存；留空保留原值。'}{saved && Date.parse(saved.expires_at) > 0 && <small className="cell-sub">官网报告的会话到期时间：{date(saved.expires_at)}</small>}</span></div>}
        <label className="field">Team ID<input value={team} onChange={e => setTeam(e.target.value)} maxLength={100} required disabled={busy} placeholder="Cookie 当前选中的团队 ID"/></label>
        <label className="field">会话 Cookie<input type="password" value={cookie} onChange={e => setCookie(e.target.value)} maxLength={32768} required={!configured || team.trim() !== savedTeam} disabled={busy} autoComplete="new-password" spellCheck={false} placeholder={configured ? '留空保留；更换团队时需重新填写 Cookie' : '直接粘贴完整会话值，或填写 名称=值'}/></label>
        <details className="advanced"><summary>从哪里获取 Cookie？</summary><p>登录 <External href="https://dashboard.exa.ai/billing">Exa 官网</External>并选中对应团队。F12 → Application → Cookies，找到 next-auth.session-token，直接复制完整的值即可，也可按“名称=值”填写。若名称是 __Secure-next-auth.session-token，请保留名称；若有 .0、.1 分片，用“名称=值; 名称=值”连接全部分片。</p><p>只保存会话 Cookie，其他 Cookie 不参与保存。网关会接收官网返回的更新 Cookie；登录过期时仍可能需要重新复制，不保证长期自动续期。网关不会替你切换官网团队。</p></details>
        {error && <div className="notice warn" role="alert">{error}</div>}
      </div>
      <div className="modal-footer">
        {configured && <button type="button" className="button danger" disabled={busy} onClick={async () => { setBusy(true); const ok = await run(() => api(path, { method: 'DELETE' }), 'Exa 登录 Cookie 已移除，搜索 key 与管理凭证保留'); setBusy(false); if (ok) onClose(); }}>移除登录凭证</button>}
        <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="button primary" disabled={busy}>{busy && <Spinner/>}保存并查询余额</button>
      </div>
    </form>
  </Modal>;
}
