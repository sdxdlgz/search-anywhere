import { useEffect, useState } from 'react';
import { Check, Compass, Gauge, Layers, Save, ShieldCheck, Zap } from 'lucide-react';
import { MODES, PROVIDERS, type Profile } from '../../shared/types';
import type { Data, RunAction } from '../App';
import { api, json } from '../api';
import { ProviderMark, providerName, Spinner } from '../components';

export function Profiles({ data, run }: { data: Data; run: RunAction }) {
  const [id, setId] = useState(data.settings.default_profile), [draft, setDraft] = useState<Profile>(data.profiles.find(p => p.id === id)!);
  const [busy, setBusy] = useState(false);
  const original = data.profiles.find(p => p.id === id)!;
  useEffect(() => { setDraft(original); }, [id, original.version]);
  const Icon = { fast: Zap, balanced: Layers, thorough: Compass }[id] || Layers;
  return <div className="page-enter"><div className="page-heading"><div><div className="eyebrow">SEARCH PROFILES</div><h1>搜索预设<span className="heading-dot">.</span></h1><p>一次配置，让所有客户端使用同一套搜索策略。</p></div><span className="outline-pill"><ShieldCheck size={15}/>更改仅影响新请求</span></div>
    <div className="profile-tabs">{data.profiles.map(p => { const ItemIcon = { fast: Zap, balanced: Layers, thorough: Compass }[p.id] || Layers; return <button key={p.id} className={`profile-tab ${id === p.id ? 'selected' : ''}`} onClick={() => setId(p.id)}><span className="profile-icon"><ItemIcon size={22}/></span><div><strong>{p.name}</strong><small>{p.id}</small></div>{data.settings.default_profile === p.id && <span className="tiny-status available">默认</span>}</button>; })}</div>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); await run(() => api(`/profiles/${id}`, { method: 'PUT', body: json(draft) }), '搜索预设已保存，下一次请求生效'); setBusy(false); }}>
      <section className="panel profile-editor"><div className="panel-heading"><div><h2><Icon size={18}/>{original.name}</h2><p>各家模式独立配置；开关控制该渠道是否参与并行搜索。</p></div><button type="button" className="button small" disabled={data.settings.default_profile === id} onClick={() => void run(() => api('/settings', { method: 'PUT', body: json({ ...data.settings, default_profile: id }) }), '默认搜索预设已更新')}>{data.settings.default_profile === id ? <><Check size={14}/>当前默认</> : '设为默认'}</button></div>
        <div className="mode-rows">{PROVIDERS.map(provider => <div className={`mode-row ${draft.modes[provider] ? '' : 'off'}`} key={provider}><ProviderMark provider={provider}/><div className="mode-name"><strong>{providerName[provider]}</strong><span>{provider === 'exa' ? 'type' : provider === 'tavily' ? 'search_depth' : provider === 'anysearch' ? '自动路由' : 'mode'}</span></div><label className="field mode-select"><span className="sr-only">{providerName[provider]} 搜索模式</span><select disabled={!draft.modes[provider]} value={draft.modes[provider] || MODES[provider][0]} onChange={e => setDraft({ ...draft, modes: { ...draft.modes, [provider]: e.target.value } })}>{MODES[provider].map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label><label className="switch"><input aria-label={`启用 ${providerName[provider]}`} type="checkbox" checked={!!draft.modes[provider]} onChange={e => setDraft({ ...draft, modes: { ...draft.modes, [provider]: e.target.checked ? MODES[provider][0] : null } })}/><span/></label></div>)}</div>
        <div className="profile-settings">
          <label className="field">Parallel 接入策略<select disabled={!draft.modes.parallel} value={draft.parallel_transport ?? 'free_first'} onChange={e => setDraft({ ...draft, parallel_transport: e.target.value as Profile['parallel_transport'] })}><option value="free_first">免费优先，限流后使用 API key</option><option value="api">始终使用 API key</option></select><small>{draft.modes.parallel === 'advanced' ? 'advanced 直接使用 API key，保留高强度搜索' : '免费固定 fast；限流后按上方所选模式调用 API'}</small></label>
          <label className="field">每家检索数量<input type="number" min={1} max={100} value={draft.per_provider_results ?? draft.max_results} onChange={e => setDraft({ ...draft, per_provider_results: Number(e.target.value) })} required/><small>按供应商上限调整；各家返回结果全部保存</small></label>
          <label className="field">每页展示数量<input type="number" min={1} max={30} value={draft.max_results} onChange={e => setDraft({ ...draft, max_results: Number(e.target.value) })} required/><small>只控制分页，不削减收集数量</small></label>
          <label className="field">整体超时（秒）<input type="number" min={1} max={180} value={draft.timeout_ms / 1000} onChange={e => setDraft({ ...draft, timeout_ms: Number(e.target.value) * 1000 })} required/><small>超时保留已完成结果，并报告缺失渠道</small></label>
          <label className="field">正文读取策略<select value={draft.fetch_strategy ?? 'fallback'} onChange={e => setDraft({ ...draft, fetch_strategy: e.target.value as Profile['fetch_strategy'] })}><option value="parallel">并行收集各家版本</option><option value="fallback">依次回退，成功即返回</option></select><small>覆盖优先使用并行；模型负责核对版本</small></label>
          <label className="field">缓存有效期（秒）<input type="number" min={0} max={3600} value={draft.cache_ttl_seconds} onChange={e => setDraft({ ...draft, cache_ttl_seconds: Number(e.target.value) })} required/><small>0 关闭；已存证据仍可读取</small></label>
        </div>
        <div className="panel-footer"><span>版本 {original.version} · 按 URL 合并，保留每份来源摘录</span><button className="button primary" disabled={busy}>{busy ? <Spinner/> : <Save size={16}/>}保存预设</button></div>
      </section>
    </form><div className="notice subtle"><Gauge size={18}/><span>免费 Parallel 无需 key；仅该入口免费，其他渠道照常计费。返回数量由上游决定，单次摘录合计约限 25,000 字符，可继续读取网页正文。覆盖优先和深入搜索默认用 advanced；同一网页多家命中仍只是一份来源，后续补搜和求证由模型完成。</span></div>
  </div>;
}
