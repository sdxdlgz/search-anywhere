import { useState } from 'react';
import { Check, Code2, KeyRound, Link2, Plus, Save, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import type { Data, RunAction } from '../App';
import type { Settings } from '../../shared/types';
import { api, date, json } from '../api';
import { Badge, CopyButton, Modal, Spinner } from '../components';
import { ClientTokenUsage } from './ClientTokenUsage';

export function Connections({ data, run }: { data: Data; run: RunAction }) {
  const [name, setName] = useState(''), [token, setToken] = useState(''), [busy, setBusy] = useState(false), [settings, setSettings] = useState<Settings>(data.settings);
  const [period, setPeriod] = useState<'lifetime' | 'month'>('lifetime');
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedCount = data.tokens.filter(t => !t.enabled).length;
  const visibleTokens = data.tokens.filter(t => t.enabled || showRevoked);
  const base = window.location.origin;
  const config = JSON.stringify({ mcpServers: { 'search-anywhere': { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer YOUR_SEARCH_KEY' } } } }, null, 2);
  return <div className="page-enter"><div className="page-heading"><div><div className="eyebrow">CONNECT YOUR WORKFLOW</div><h1>客户端接入<span className="heading-dot">.</span></h1><p>模型照常使用，让搜索连接到这里。</p></div><span className="outline-pill"><Link2 size={15}/>HTTP + Streamable HTTP MCP</span></div>
    <div className="endpoint-grid"><section className="panel endpoint-card"><span className="endpoint-icon"><Link2 size={20}/></span><h2>MCP 工具服务</h2><p>提供 search、search_results、get_evidence、fetch；客户端工具超时建议至少 180 秒。</p><div className="endpoint-value"><code>{base}/mcp</code><CopyButton value={`${base}/mcp`}/></div></section><section className="panel endpoint-card"><span className="endpoint-icon"><Code2 size={20}/></span><h2>统一搜索 API</h2><p>适用于自定义工具、工作流和后续 Pi 扩展。</p><div className="endpoint-value"><code>POST {base}/v1/search</code><CopyButton value={`${base}/v1/search`}/></div></section></div>
    <section className="panel"><div className="panel-heading"><div><h2>搜索访问凭证</h2><p>为每个客户端单独签发，便于追踪用量和单独撤销。</p></div><ShieldCheck size={19}/></div><form className="token-form" onSubmit={async e => { e.preventDefault(); setBusy(true); await run(async () => { const created = await api<{ token: string }>('/tokens', { method: 'POST', body: json({ name }) }); setToken(created.token); setName(''); }, '搜索访问凭证已创建'); setBusy(false); }}><label className="field"><span className="sr-only">客户端名称</span><input placeholder="客户端名称，例如 Hermes / Codex" value={name} onChange={e => setName(e.target.value)} maxLength={100} required/></label><button className="button primary" disabled={busy}>{busy ? <Spinner/> : <Plus size={16}/>}生成访问凭证</button></form>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-4" role="group" aria-label="凭证统计周期">
        <button className={`button small ${period === 'lifetime' ? 'primary' : ''}`} aria-pressed={period === 'lifetime'} onClick={() => setPeriod('lifetime')}>累计</button>
        <button className={`button small ${period === 'month' ? 'primary' : ''}`} aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>本月（UTC）</button>
        {revokedCount > 0 && <label className="inline-flex items-center gap-2 text-sm text-muted cursor-pointer"><input type="checkbox" checked={showRevoked} onChange={e => setShowRevoked(e.target.checked)}/>显示已撤销（{revokedCount}）</label>}
        <small className="text-muted">消耗按上游报告或内置计费估算；不同供应商的 credits 分别统计，≈ 表示估算。</small>
      </div>
      {visibleTokens.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>客户端 / 访问凭证</th><th>状态</th><th>请求与调用</th><th>已记录消耗</th><th>最近使用</th><th className="align-right">操作</th></tr></thead><tbody>{visibleTokens.map(t => <tr key={t.id}><td><strong>{t.name}</strong><small className="cell-sub"><code>{t.masked}</code></small></td><td><Badge state={t.enabled ? 'ready' : 'disabled'}/></td><ClientTokenUsage usage={t.usage?.[period]}/><td>{date(t.last_used)}</td><td className="align-right"><button className="button small" disabled={!t.enabled} onClick={() => void run(() => api(`/tokens/${t.id}`, { method: 'DELETE' }), '访问凭证已撤销')}><Trash2 size={13}/>撤销</button></td></tr>)}</tbody></table></div> : <div className="simple-empty">{revokedCount ? '暂无可用的访问凭证。勾选“显示已撤销”可查看历史用量。' : '还没有访问凭证。生成后填入客户端的 Authorization 请求头。'}</div>}
      <p className="px-6 py-4 text-xs text-muted">统计进入检索流程的搜索与正文请求，包含缓存命中；重试和多渠道检索分别计入上游调用。读取已存结果、证据分页及 MCP 连接不计数。清理历史后统计保留；旧记录仅在能确认凭证归属时补计。点击页面“刷新”更新统计。</p>
    </section>
    <div className="integration-grid"><section className="panel code-panel"><div className="panel-heading"><div><h2>MCP 配置示例</h2><p>Claude Code 风格 JSON；其他客户端字段见项目 README。</p></div><CopyButton value={config}/></div><pre>{config}</pre><div className="notice subtle"><Terminal size={16}/><span>服务地址须能被客户端访问。其他设备上的 127.0.0.1 指向设备自身；远程部署请使用可达的 HTTPS 地址。</span></div></section>
      <section className="panel settings-panel"><div className="panel-heading"><div><h2>网关运行设置</h2><p>集中控制用量与同步频率。</p></div></div><form onSubmit={async e => { e.preventDefault(); setBusy(true); await run(() => api('/settings', { method: 'PUT', body: json(settings) }), '网关设置已保存'); setBusy(false); }}><label className="field">默认搜索预设<select value={settings.default_profile} onChange={e => setSettings({ ...settings, default_profile: e.target.value })}>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">每日上游调用上限<input type="number" min={0} max={1000000} value={settings.daily_call_limit} onChange={e => setSettings({ ...settings, daily_call_limit: Number(e.target.value) })} required/><small>UTC 每日重置，含搜索、重试和正文读取；0 为不限。</small></label><label className="field">官方用量同步间隔（分钟）<input type="number" min={0} max={1440} value={settings.usage_sync_minutes} onChange={e => setSettings({ ...settings, usage_sync_minutes: Number(e.target.value) })} required/><small>0 关闭自动同步，仍可手动刷新。查询结果可能存在账单延迟。</small></label><button className="button primary" disabled={busy}>{busy ? <Spinner/> : <Save size={16}/>}保存设置</button></form></section>
    </div>
    {token && <Modal title="保存你的搜索访问凭证" subtitle="完整凭证仅在本次创建时显示，关闭后无法再次查看。" onClose={() => setToken('')}><div className="modal-body"><div className="new-token"><code>{token}</code><CopyButton value={token} label="复制凭证"/></div><p className="text-muted">这是客户端连接网关的凭证，只能调用搜索和正文工具，不能查看上游密钥或修改管理配置。</p></div><div className="modal-footer"><button className="button primary" onClick={() => setToken('')}><Check size={16}/>我已保存</button></div></Modal>}
  </div>;
}
