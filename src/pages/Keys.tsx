import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, KeyRound, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { PROVIDERS, type KeyPublic, type Provider, type UsageSnapshot } from '../../shared/types';
import type { Data, RunAction } from '../App';
import { api, date, json, number } from '../api';
import { Badge, Empty, Modal, ProviderMark, providerName, Spinner, Usage } from '../components';
import { refreshSelectedUsage, type UsagePatch, type UsageRefreshResult } from '../usage-refresh';
import { ProviderLogin } from './ProviderLogin';
import { ExaLogin } from './ExaLogin';
import { ParallelLogin } from './ParallelLogin';

export function Keys({ data, run, updateUsage, onAdd, onEdit }: { data: Data; run: RunAction; updateUsage: (id: string, patch: UsagePatch) => void; onAdd: () => void; onEdit: (key: KeyPublic) => void }) {
  const [provider, setProvider] = useState<Provider | 'all'>('all'), [query, setQuery] = useState(''), [remove, setRemove] = useState<KeyPublic | null>(null);
  const [busy, setBusy] = useState<Record<string, 'usage' | 'probe'>>({}), [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ total: number; done: number; results: UsageRefreshResult[]; running: boolean } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [login, setLogin] = useState<KeyPublic | null>(null);
  const orderedKeys = useMemo(() => {
    const groups = new Map<string, KeyPublic[]>();
    for (const key of [...data.keys].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const group = JSON.stringify([key.provider, key.account]);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(key);
    }
    return [...groups.values()].flat();
  }, [data.keys]);
  const rows = orderedKeys.filter(k => (provider === 'all' || provider === k.provider) && `${k.label} ${k.account} ${k.masked}`.toLowerCase().includes(query.toLowerCase()));
  const chosen = rows.filter(key => selected.has(key.id));
  useEffect(() => { setSelected(previous => new Set([...previous].filter(id => data.keys.some(k => k.id === id)))); }, [data.keys]);
  useEffect(() => {
    if (!batch || batch.running) return;
    const timer = setTimeout(() => setBatch(null), batch.results.some(r => r.error || r.usage?.status !== 'ok') ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [batch]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const release = (id: string) => setBusy(previous => { const next = { ...previous }; delete next[id]; return next; });
  const queryUsage = async (id: string) => {
    try { return await api<UsageSnapshot>(`/keys/${id}/usage`, { method: 'POST' }); }
    finally {
      if (data.keys.find(k => k.id === id)?.provider === 'exa') {
        const updated = await api<KeyPublic>(`/keys/${id}/exa-balance`).catch(() => undefined);
        if (updated) updateUsage(id, { usage: updated.usage, usage_error: updated.usage_error, exa_balance: updated.exa_balance });
      }
    }
  };
  const record = (result: UsageRefreshResult) => {
    updateUsage(result.id, { ...(result.usage ? { usage: result.usage } : {}), usage_error: result.error || null });
    release(result.id);
  };
  const refreshOne = async (key: KeyPublic) => {
    setBusy(previous => ({ ...previous, [key.id]: 'usage' })); setNotice(null);
    try { const usage = await queryUsage(key.id); record({ id: key.id, usage }); setNotice({ text: usage.status === 'ok' ? `仅 ${key.label} 的${usage.source === 'estimated' ? '本地估算' : '官方用量'}已刷新。` : `${key.label}：${usage.message}`, error: false }); }
    catch (e) { const error = (e as Error).message; record({ id: key.id, error }); setNotice({ text: `${key.label}：${error}`, error: true }); }
  };
  const refreshBatch = async () => {
    const ids = chosen.map(k => k.id);
    setNotice(null); setBatch({ total: ids.length, done: 0, results: [], running: true });
    setBusy(previous => ({ ...previous, ...Object.fromEntries(ids.map(id => [id, 'usage' as const])) }));
    try {
      await refreshSelectedUsage(ids, queryUsage, result => {
        record(result); setBatch(previous => previous ? { ...previous, done: previous.done + 1, results: [...previous.results, result] } : previous);
      });
    } catch (e) { ids.forEach(release); setNotice({ text: (e as Error).message, error: true }); }
    finally { setBatch(previous => previous ? { ...previous, running: false } : previous); }
  };
  const probe = async (key: KeyPublic) => {
    setBusy(previous => ({ ...previous, [key.id]: 'probe' }));
    try { await run(() => api(`/keys/${key.id}/test`, { method: 'POST' }), '密钥测试成功，调用用量已记录'); }
    finally { release(key.id); }
  };
  const toggle = (id: string, checked: boolean) => setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  return <div className="page-enter"><div className="page-heading"><div><div className="eyebrow">PROVIDERS & CREDENTIALS</div><h1>供应商与密钥<span className="heading-dot">.</span></h1><p>密钥有序轮询，账号归属一目了然。</p></div><button className="button primary" onClick={onAdd}><Plus size={17}/>添加密钥</button></div>
    <div className="provider-grid compact">{PROVIDERS.map(p => { const keys = data.keys.filter(k => k.provider === p); return <button key={p} className={`provider-card ${provider === p ? 'selected' : ''}`} onClick={() => setProvider(provider === p ? 'all' : p)}><ProviderMark provider={p}/><div><strong>{providerName[p]}</strong><span>{keys.filter(k => k.state === 'ready').length} 个可用 / {keys.length} 个密钥</span></div><ChevronDown size={16}/></button>; })}</div>
    <section className="panel"><div className="table-toolbar"><div className="tabs" aria-label="渠道筛选"><button className={provider === 'all' ? 'active' : ''} onClick={() => setProvider('all')}>全部密钥 <span>{data.keys.length}</span></button>{PROVIDERS.map(p => <button key={p} className={provider === p ? 'active' : ''} onClick={() => setProvider(p)}>{providerName[p]}</button>)}</div><label className="search-field"><Search size={16}/><input aria-label="搜索密钥或账号" placeholder="搜索名称、账号或密钥片段" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
      <div className="usage-toolbar"><div><strong>已选当前筛选内 {chosen.length} 个 key</strong><small>行内“查询用量”只查该 key；批量最多 100 个，不执行搜索。</small></div><button className="button" disabled={!chosen.length || chosen.length > 100 || !!batch?.running || chosen.some(key => !!busy[key.id])} onClick={() => void refreshBatch()}>{batch?.running ? <Spinner/> : <RefreshCw size={15}/>}批量查询所选用量（{chosen.length}）</button></div>
      {notice && <div className={`notice ${notice.error ? 'warn' : 'subtle'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
      {batch && <div className="batch-results" aria-live="polite"><div className="batch-heading"><strong>{batch.running ? '批量查询中' : '批量查询完成'} · {batch.done} / {batch.total}</strong>{!batch.running && <button className="icon-button" aria-label="关闭批量查询提示" onClick={() => setBatch(null)}><X size={15}/></button>}</div><span>成功 {batch.results.filter(r => r.usage?.status === 'ok').length} · 失败 {batch.results.filter(r => r.error).length} · 未支持 / 待配置 {batch.results.filter(r => r.usage && r.usage.status !== 'ok').length}</span>{batch.results.some(r => r.error || r.usage?.status !== 'ok') && <small>未完成项的原因保留在对应 key 的官方用量栏，可单独重试。</small>}</div>}
      {data.keys.length === 0 ? <Empty title="把你的搜索密钥放在一起" onAdd={onAdd}>支持同一家供应商添加多个 key，原始密钥加密存储，保存后仅显示首尾片段。</Empty> : <div className="table-scroll"><table className="data-table key-table"><thead><tr>
        <th className="selection-cell"><input type="checkbox" aria-label="选择当前筛选的全部密钥" checked={rows.length > 0 && rows.every(k => selected.has(k.id))} disabled={!rows.length || !!batch?.running} onChange={e => { const checked = e.target.checked; setSelected(previous => { const next = new Set(previous); rows.forEach(k => { if (checked) next.add(k.id); else next.delete(k.id); }); return next; }); }}/></th><th>渠道 / 密钥</th><th>账号归属</th><th>状态</th><th>网关记录</th><th>额度与用量</th><th className="align-right">操作</th>
      </tr></thead><tbody>{rows.map(key => <tr key={key.id}>
        <td className="selection-cell"><input type="checkbox" aria-label={`选择 ${key.label}`} checked={selected.has(key.id)} disabled={!!batch?.running} onChange={e => toggle(key.id, e.target.checked)}/></td>
        <td><div className="key-identity"><ProviderMark provider={key.provider}/><div><strong>{key.label}</strong><code>{key.masked}</code><small className="cell-sub">添加于 <time dateTime={key.created_at} title={new Date(key.created_at).toLocaleString('zh-CN')}>{date(key.created_at)}</time></small></div></div></td>
        <td><div className="owner-cell"><UserRound size={14}/><span>{key.account}</span></div><small className="cell-sub">{providerName[key.provider]} · 并发 {key.max_concurrency}</small></td>
        <td><Badge state={key.state}/>{key.last_error && <small className="cell-error" title={key.last_error}>{key.last_error}</small>}</td>
        <td><strong className="tabular">累计调用 {number(key.calls)} 次</strong><small className="cell-sub">成功 {number(key.successes)} 次</small><LocalMeter metering={key.metering}/></td>
        <td><Usage usage={key.usage} error={key.usage_error} metering={key.metering} exaBalance={key.exa_balance}/></td>
        <td><div className="row-actions"><button className="button small" aria-label={`查询 ${key.label} 用量`} title="只查询这个 key 的官方用量，不执行搜索" disabled={!!busy[key.id]} onClick={() => void refreshOne(key)}>{busy[key.id] === 'usage' ? <Spinner/> : <RefreshCw size={15}/>}查询用量</button>{['keenable', 'anysearch', 'exa', 'parallel'].includes(key.provider) && <button className="icon-button" aria-label={`配置 ${key.label} ${key.provider === 'exa' ? '余额' : '登录凭证'}`} title={key.provider === 'exa' ? '配置余额：官网查询或手动估算' : key.keenable_login || key.anysearch_login || key.parallel_login ? '管理官网登录凭证' : '配置官网登录凭证以查询余额'} disabled={!!busy[key.id]} onClick={() => setLogin(key)}><KeyRound size={15}/></button>}<button className="icon-button" aria-label={`测试 ${key.label}`} title="执行一次搜索测试，可能消耗额度" disabled={!!busy[key.id] || key.state !== 'ready'} onClick={() => void probe(key)}>{busy[key.id] === 'probe' ? <Spinner/> : <Play size={15}/>}</button><button className="icon-button" aria-label={`编辑 ${key.label}`} disabled={!!busy[key.id]} onClick={() => onEdit(key)}><Pencil size={15}/></button><button className="icon-button danger" aria-label={`删除 ${key.label}`} disabled={!!busy[key.id]} onClick={() => setRemove(key)}><Trash2 size={15}/></button></div></td>
      </tr>)}</tbody></table>{!rows.length && <div className="table-empty">没有匹配的密钥。</div>}</div>}
      <div className="table-foot"><span><ShieldCheck size={14}/>已保存的 key 不提供明文查看或导出</span><span>{rows.length} 个密钥</span></div>
    </section><div className="usage-toolbar panel"><div><strong>自动同步：{data.settings.usage_sync_minutes ? `每 ${data.settings.usage_sync_minutes} 分钟` : '已关闭'}</strong><small>定时同步独立运行，不由单行按钮或页面刷新触发；间隔可在“客户端接入”调整。</small></div>{!!data.settings.usage_sync_minutes && <button className="button small" onClick={() => void run(() => api('/settings', { method: 'PUT', body: json({ ...data.settings, usage_sync_minutes: 0 }) }), '自动用量同步已暂停；单个和批量查询仍可使用')}>暂停自动同步</button>}</div>
    <div className="info-grid"><div className="notice subtle"><RefreshCw size={18}/><span><strong>三种数字分开显示</strong>调用次数、本地消费记录和官方用量快照不是同一个指标。官方数据可能存在延迟或统计范围差异。</span></div><div className="notice subtle"><UserRound size={18}/><span><strong>额度按渠道汇总</strong>每个 key 对应独立账号，来源备注只用于辨认；概览按渠道累计已同步的套餐额度。</span></div></div>
    {remove && <Modal title="删除这个密钥？" onClose={() => setRemove(null)}><div className="modal-body"><p>删除 <strong>{remove.label}</strong>（{remove.masked}）。历史调用及账号归属会保留，后续搜索不再使用此 key。</p></div><div className="modal-footer"><button className="button" onClick={() => setRemove(null)}>取消</button><button className="button danger-solid" onClick={async () => { if (await run(() => api(`/keys/${remove.id}`, { method: 'DELETE' }), '密钥已删除')) setRemove(null); }}>确认删除</button></div></Modal>}
    {login && (login.provider === 'parallel' ? <ParallelLogin credential={login} run={run} onClose={() => setLogin(null)}/> : login.provider === 'exa' ? <ExaLogin credential={login} run={run} onClose={() => setLogin(null)}/> : <ProviderLogin credential={login} run={run} onClose={() => setLogin(null)}/>)}
  </div>;
}

function LocalMeter({ metering }: { metering?: KeyPublic['metering'] }) {
  if (!metering) return null;
  return <div className="local-meter" title={`${metering.month} · UTC 自然月 · 仅经过本网关的调用`}>
    {metering.reported_calls > 0 && <><strong>本月已记录 {number(metering.reported_credits)} credits</strong><small className="cell-sub">上游调用响应报告</small></>}
    {metering.estimated_calls > 0 && <small className="cell-sub">本月估算 {number(metering.estimated_credits)} credits</small>}
    {metering.unreported_calls > 0 && <small className="cell-sub">本月 {metering.unreported_calls} 次未报告消费</small>}
  </div>;
}

export function KeyDialog({ initial, run, onClose }: { initial?: KeyPublic; run: RunAction; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>(initial?.provider || 'exa'), [label, setLabel] = useState(initial?.label || ''), [account, setAccount] = useState(initial?.account || '');
  const [keys, setKeys] = useState(''), [concurrency, setConcurrency] = useState(initial?.max_concurrency || 2), [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [keyId, setKeyId] = useState(initial?.exa_key_id || ''), [serviceKey, setServiceKey] = useState(''), [reset, setReset] = useState(false), [busy, setBusy] = useState(false);
  return <Modal title={initial ? '编辑密钥' : '添加搜索密钥'} subtitle="密钥只用于上游搜索，加密保存后不再返回明文。" onClose={onClose}>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); const common = { label, account, max_concurrency: concurrency, exa_key_id: keyId, ...(serviceKey ? { service_key: serviceKey } : {}) }; const ok = await run(() => initial ? api(`/keys/${initial.id}`, { method: 'PATCH', body: json({ ...common, enabled, reset }) }) : api('/keys', { method: 'POST', body: json({ ...common, provider, keys: keys.split(/\r?\n/).map(s => s.trim()).filter(Boolean) }) }), initial ? '密钥设置已更新' : '密钥已添加'); setBusy(false); if (ok) { setKeys(''); setServiceKey(''); onClose(); } }}>
      <div className="modal-body"><label className="field">搜索供应商<select value={provider} disabled={!!initial} onChange={e => setProvider(e.target.value as Provider)}>{PROVIDERS.map(p => <option key={p} value={p}>{providerName[p]}</option>)}</select></label>
        <div className="form-grid"><label className="field">密钥名称<input value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：日常搜索" maxLength={100} required autoFocus/></label><label className="field">账号归属<input value={account} onChange={e => setAccount(e.target.value)} placeholder="邮箱或账号来源备注" maxLength={100} required/></label></div>
        {initial ? <div className="saved-secret"><KeyRound size={16}/><code>{initial.masked}</code><span>原始密钥已加密保存</span></div> : <label className="field">API key<textarea className="secret-input" rows={3} value={keys} onChange={e => setKeys(e.target.value)} placeholder="粘贴 API key；批量添加时每行一个" autoComplete="off" spellCheck={false} required/><small>每次最多 50 个。批量添加共用来源备注，名称自动编号；每个 key 的账号额度单独计入渠道总额。</small></label>}
        <label className="field">单 key 最大并发<input type="number" min={1} max={16} value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} required/></label>
        {provider === 'exa' && <details className="advanced"><summary>Exa 官方用量查询（可选）<ChevronDown size={15}/></summary><p>需在 Exa 开通 Team Management API。Service Key 按账号加密保存，搜索 key ID 用于定位用量；留空仍可搜索并记录本地用量。</p><label className="field">搜索 key 的 ID<input value={keyId} onChange={e => setKeyId(e.target.value)} placeholder="Exa 控制台中的 key ID" maxLength={100}/></label><label className="field">账号 Service Key<input type="password" value={serviceKey} onChange={e => setServiceKey(e.target.value)} placeholder={initial?.has_management_key ? '此账号已配置；留空保留原值' : '可选：管理凭证'} autoComplete="new-password"/></label></details>}
        {initial && <div className="toggle-list"><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>启用此密钥</label>{initial.state !== 'ready' && <label><input type="checkbox" checked={reset} onChange={e => setReset(e.target.checked)}/>清除错误 / 冷却状态并重新加入轮询</label>}</div>}
      </div><div className="modal-footer"><span><ShieldCheck size={14}/>加密存储 · 首尾脱敏</span><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? <Spinner/> : <Check size={16}/>}保存密钥</button></div>
    </form>
  </Modal>;
}
