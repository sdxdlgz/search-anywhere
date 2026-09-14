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
  const [mode, setMode] = useState(credential.exa_balance?.mode || 'official');
  const [amount, setAmount] = useState(''), [manualTeam, setManualTeam] = useState(credential.exa_balance?.team_id || saved?.team_id || '');
  return <Modal title="Exa 余额配置" subtitle={`${credential.label} · ${credential.account}`} onClose={onClose}>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      if (mode === 'manual') {
        const ok = await run(async () => {
          try { await api(`/keys/${credential.id}/exa-balance`, { method: 'PUT', body: json({ mode, balance_usd: Number(amount), team_id: manualTeam.trim() }) }); }
          catch (e) { setError((e as Error).message); throw e; }
        }, 'Exa 本地余额已校准，后续调用自动扣减估算费用');
        setBusy(false); if (ok) onClose(); return;
      }
      const ok = await run(async () => {
        try {
          if (credential.exa_balance?.mode === 'manual') await api(`/keys/${credential.id}/exa-balance`, { method: 'PUT', body: json({ mode: 'official' }) });
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
        <label className="field">余额方式<select value={mode} onChange={e => setMode(e.target.value as 'official' | 'manual')} disabled={busy}><option value="official">官网自动查询</option><option value="manual">手动余额 · 本地估算</option></select></label>
        {mode === 'manual' ? <>
          <p>输入此刻官网显示的美元余额。保存后只扣除新发生的本网关费用，自动官网查询暂停。</p>
          {credential.usage?.local_balance && <div className="notice subtle"><span>当前本地估算 ${credential.usage.local_balance.remaining_usd.toFixed(6)} · 上次校准 {date(credential.usage.local_balance.calibrated_at)}</span></div>}
          <label className="field">当前余额（USD）<input type="number" step="0.000001" min="-1000000" max="1000000" required value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} placeholder="填写官网当前余额，支持 0"/></label>
          <label className="field">共享 Team ID（可选）<input value={manualTeam} onChange={e => setManualTeam(e.target.value)} maxLength={100} pattern={"[A-Za-z0-9_\\-]*"} disabled={busy} placeholder="同团队 key 填相同 ID；留空按这把 key 单独统计"/></label>
          <small className="cell-sub">填写相同 Team ID 会共用并校准同一份余额；这是你指定的归属，不代表官网已验证。来源备注不参与计算。</small>
          <details className="advanced"><summary>估算如何扣费？</summary><p>优先使用上游返回的 costDollars；缺少时按内置公开单价和上游返回条数估算。失败且费用未知的调用会单列提醒。估算不等于最终账单，其他平台消费、充值、赠额及到期不会自动计入，需要重新校准。</p><p>普通搜索每次 $0.007；deep / deep-lite $0.012；deep-reasoning $0.015。超过 10 条每条加 $0.001，当前正文读取每页 $0.001。价格核对于 2026-09-14，见 <External href="https://exa.ai/pricing">官方价格</External>。</p></details>
        </> : <>
        <p>使用官网会话查询团队美元余额，无需 Service Key。保存后会核对 Cookie 当前团队与搜索 key 所属团队。</p>
        {credential.exa_balance?.pause_reason === 'challenge' && <div className="notice subtle"><span>官网要求浏览器验证，自动查询已暂停。可切换到手动估算；重新保存查询会尝试恢复官网同步。</span></div>}
        {configured && <div className="notice subtle"><span>{saved?.needs_login ? '登录需要更新；已有余额快照仍保留。' : 'Cookie 已加密保存；留空保留原值。'}{saved && Date.parse(saved.expires_at) > 0 && <small className="cell-sub">官网报告的会话到期时间：{date(saved.expires_at)}</small>}</span></div>}
        <label className="field">Team ID<input value={team} onChange={e => setTeam(e.target.value)} maxLength={100} required disabled={busy} placeholder="Cookie 当前选中的团队 ID"/></label>
        <label className="field">会话 Cookie<input type="password" value={cookie} onChange={e => setCookie(e.target.value)} maxLength={32768} required={!configured || team.trim() !== savedTeam} disabled={busy} autoComplete="new-password" spellCheck={false} placeholder={configured ? '留空保留；更换团队时需重新填写 Cookie' : '直接粘贴完整会话值，或填写 名称=值'}/></label>
        <details className="advanced"><summary>从哪里获取 Cookie？</summary><p>登录 <External href="https://dashboard.exa.ai/billing">Exa 官网</External>并选中对应团队。F12 → Application → Cookies，找到 next-auth.session-token，直接复制完整的值即可，也可按“名称=值”填写。若名称是 __Secure-next-auth.session-token，请保留名称；若有 .0、.1 分片，用“名称=值; 名称=值”连接全部分片。</p><p>只保存会话 Cookie，其他 Cookie 不参与保存。网关会接收官网返回的更新 Cookie；登录过期时仍可能需要重新复制，不保证长期自动续期。网关不会替你切换官网团队。</p></details>
        </>}
        {error && <div className="notice warn" role="alert">{error}</div>}
      </div>
      <div className="modal-footer">
        {configured && mode === 'official' && <button type="button" className="button danger" disabled={busy} onClick={async () => { setBusy(true); const ok = await run(() => api(path, { method: 'DELETE' }), 'Exa 登录 Cookie 已移除，搜索 key 与管理凭证保留'); setBusy(false); if (ok) onClose(); }}>移除登录凭证</button>}
        <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="button primary" disabled={busy}>{busy && <Spinner/>}{mode === 'manual' ? '保存并校准余额' : '保存并查询余额'}</button>
      </div>
    </form>
  </Modal>;
}
