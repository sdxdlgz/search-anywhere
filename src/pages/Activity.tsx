import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Clock3, ExternalLink, FileText, FlaskConical, Search, Terminal, Zap } from 'lucide-react';
import type { Data } from '../App';
import type { CallLog, RequestLog, SearchResponse } from '../../shared/types';
import { api, date, json, number } from '../api';
import { Badge, Empty, ProviderMark, providerName, Spinner } from '../components';
import { EvidenceReader } from './EvidenceReader';

function WarningDetails({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return <details className="mt-2 min-w-48 max-w-lg text-xs text-warn">
    <summary className="cursor-pointer">查询提示（{warnings.length}）</summary>
    <ul className="mt-2 grid gap-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
  </details>;
}

function reportedUsage(call: CallLog): string {
  if (call.billing_source === 'free') return '免费 · $0';
  if (call.cost_usd !== null) return `$${call.cost_usd.toFixed(4)}`;
  if (call.credits !== null) return `${providerName[call.provider]} ${call.credits} credits${call.paid == null ? '' : call.paid ? ' · 付费额度' : ' · 免费额度'}`;
  if (call.usage_items?.length) return call.usage_items.map(item => `${item.name} × ${number(item.count)}`).join(' · ');
  return '未报告';
}

export function Logs({ initial }: { initial: RequestLog[] }) {
  const [logs, setLogs] = useState(initial), [open, setOpen] = useState(''), [query, setQuery] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => setLogs(initial), [initial]);
  const shown = logs.filter(l => `${l.query} ${l.caller} ${l.calls.map(c => c.account).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page-enter"><div className="page-heading"><div><div className="eyebrow">USAGE & REQUEST HISTORY</div><h1>用量与日志<span className="heading-dot">.</span></h1><p>从一次请求，追踪到每个供应商、密钥与账号。</p></div><span className="outline-pill"><Clock3 size={15}/>按最新请求排序</span></div>
    <div className="notice subtle"><FileText size={18}/><span>点击请求展开上游明细。失败与重试也会记录；金额为空表示上游未报告，不能视为免费。测试调用同样计入用量。</span></div>
    <section className="panel"><div className="table-toolbar"><h2>请求记录 <span className="counter">{logs.length}</span></h2><label className="search-field"><Search size={16}/><input aria-label="搜索调用日志" placeholder="搜索查询、客户端或账号" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
      {!logs.length ? <Empty title="还没有调用记录">发起一次搜索或密钥测试，就能在这里看到完整调用路径。</Empty> : <div className="request-list">{shown.map(log => <div className={`request-item ${open === log.id ? 'expanded' : ''}`} key={log.id}><button className="request-summary" onClick={() => setOpen(open === log.id ? '' : log.id)} aria-expanded={open === log.id}><span className="request-chevron">{open === log.id ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</span><span className="request-icon">{log.operation === 'fetch' ? <FileText size={17}/> : <Search size={17}/>}</span><span className="request-query"><strong>{log.query}</strong><small>{log.caller} <span>·</span> {log.profile} <span>·</span> {date(log.created_at)}</small></span>{!!log.cache_hit && <span className="cache-tag">缓存</span>}<span className="request-duration">{(log.duration_ms / 1000).toFixed(2)}s</span><Badge state={log.status}/></button>
        {open === log.id && <div className="request-detail"><div className="request-id">REQUEST ID <code>{log.id}</code></div>{log.calls.length ? <div className="table-scroll"><table className="data-table calls-table"><thead><tr><th>供应商 / 模式</th><th>密钥 / 账号</th><th>状态</th><th>结果 / 耗时</th><th>消费</th></tr></thead><tbody>{log.calls.map(call => <tr key={call.id}><td><div className="inline-provider"><ProviderMark provider={call.provider}/><div><strong>{providerName[call.provider]}</strong><code>{call.mode}</code><small className="cell-sub">{call.transport === 'free_mcp' ? '免费 MCP' : 'API key'}{call.fallback_reason === 'free_rate_limited' ? ' · 免费限流后补充' : ''}</small></div></div></td><td><strong>{call.key_label} <code className="text-muted">{call.masked}</code></strong><small className="cell-sub">{call.account}</small></td><td><Badge state={call.status}/>{call.error_code && <small className="cell-sub text-warn">{call.error_code}{call.http_status ? ` · ${call.http_status}` : ''}</small>}<WarningDetails warnings={call.warnings}/></td><td>{call.result_count} 条<small className="cell-sub">{(call.duration_ms / 1000).toFixed(2)}s</small></td><td>{reportedUsage(call)}<small className="cell-sub">{call.billing_source === 'free' ? '匿名免费入口' : call.billing_source === 'reported' ? '上游报告' : call.billing_source === 'estimated' ? '本地估算' : '费用未知'}</small></td></tr>)}</tbody></table></div> : <p className="text-muted">{log.cache_hit ? '本次复用缓存或同客户端的并发请求，未新增上游调用。' : '请求未进入上游调用，请检查可用密钥或调用上限。'}</p>}</div>}
      </div>)}</div>}
      {logs.length >= 30 && <div className="panel-footer"><span>{error}</span><button className="button small" disabled={loading} onClick={async () => { setLoading(true); setError(''); try { const more = await api<RequestLog[]>(`/logs?offset=${logs.length}&limit=30`); setLogs([...logs, ...more]); if (!more.length) setError('已加载全部记录'); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }}>{loading ? <Spinner/> : null}加载更多</button></div>}
    </section>
  </div>;
}

export function Playground({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const [query, setQuery] = useState(''), [profile, setProfile] = useState(data.settings.default_profile), [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false), [result, setResult] = useState<SearchResponse | null>(null), [error, setError] = useState('');
  const [reading, setReading] = useState(''), [page, setPage] = useState<{ url: string; content: string } | null>(null);
  const [reader, setReader] = useState<{ collection: string; urls: string[]; title: string } | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!result || result.next_offset === null) return;
    setLoadingMore(true); setError('');
    try { const next = await api<SearchResponse>('/results', { method: 'POST', body: json({ collection_id: result.collection_id, offset: result.next_offset, limit: result.scope.profile.max_results }) }); setResult(current => current?.collection_id === next.collection_id ? { ...next, results: [...current.results, ...next.results] } : current); }
    catch (e) { setError((e as Error).message); } finally { setLoadingMore(false); }
  };
  const readPage = async (url: string) => {
    setReading(url); setError(''); setReader(null); setPage(null);
    try {
      const detail = await api<{ collection_id?: string; results: { url: string; snippet: string }[] }>('/fetch', { method: 'POST', body: json({ url, profile: result?.profile || profile }) });
      if (detail.collection_id) setReader({ collection: detail.collection_id, urls: detail.results.map(r => r.url), title: '网页正文' });
      else setPage({ url, content: detail.results[0]?.snippet || '没有返回正文。' });
    } catch (e) { setError((e as Error).message); } finally { setReading(''); await reload(); }
  };
  return <div className="page-enter"><div className="page-heading"><div><div className="eyebrow">SEARCH PLAYGROUND</div><h1>搜索测试<span className="heading-dot">.</span></h1><p>试一次真实搜索，看看各家渠道如何协同。</p></div><span className="outline-pill"><FlaskConical size={15}/>直接调用 · 不使用缓存</span></div>
    <form className="panel playground-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setResult(null); setError(''); setPage(null); setReader(null); try { setResult(await api<SearchResponse>('/search', { method: 'POST', body: json({ query, profile, ...(domains.trim() ? { include_domains: domains.split(',').map(s => s.trim()).filter(Boolean) } : {}) }) })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); await reload(); } }}>
      <label className="field"><span>你想搜索什么？</span><textarea rows={3} value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：比较 PostgreSQL 与 SQLite 的适用场景" maxLength={1500} required/></label>
      <div className="playground-controls"><label className="field"><span className="sr-only">搜索预设</span><select aria-label="搜索预设" value={profile} onChange={e => setProfile(e.target.value)}>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label><label className="field domain-input"><span className="sr-only">限定域名</span><input value={domains} onChange={e => setDomains(e.target.value)} placeholder="限定域名（可选，逗号分隔）"/></label><button className="button primary" disabled={busy || !query.trim()}>{busy ? <Spinner/> : <Search size={17}/>}开始搜索</button></div><div className="form-note">测试会真实调用供应商并消耗相应额度，详细用量可在日志中查看。</div>
    </form>
    {error && <div className="notice warn" role="alert">{error}</div>}
    {busy && <div className="search-running"><span className="search-pulse"><Search size={22}/></span><h3>正在并行检索</h3><p>等待供应商返回，随后去重并融合结果…</p></div>}
    {!result && !busy && !error && <div className="playground-empty"><div className="connection-visual"><span>e</span><span>∥</span><span>t</span><span>a</span><span>k</span></div><h3>多家检索，每份证据都有出处。</h3><p>选择覆盖优先预设，收集各家结果，再交给模型核对和补搜。</p></div>}
    {result && <>
      <div className="search-outcomes">{result.providers.map(p => <div className={`outcome ${p.status}`} key={p.provider}><ProviderMark provider={p.provider}/><div><strong>{providerName[p.provider]} <code>{p.mode}</code></strong><span>{p.transport === 'free_mcp' ? '免费 MCP' : 'API key'}{p.fallback_reason === 'free_rate_limited' ? ' · 免费限流后补充' : ''}</span><span>{p.status === 'success' ? `${p.count} 条 · ${p.effective_limit == null ? '数量由上游决定' : `请求上限 ${p.effective_limit}`} · ${(p.duration_ms / 1000).toFixed(2)}s` : p.error}</span>{p.limit_reached && <small>达到请求数量，可能仍有更多资料</small>}<WarningDetails warnings={p.warnings}/></div><Badge state={p.status}/></div>)}</div>
      <div className="section-heading"><h2>融合结果 <span className="counter">{result.results.length} / {result.total_results}</span></h2><span>{result.partial ? '部分渠道返回成功' : '全部渠道完成'} · {(result.duration_ms / 1000).toFixed(2)}s</span></div>
      <div className="notice subtle">已保存 {result.total_results} 个不同 URL，域名过滤移除 {result.scope.filtered_results} 个。同一 URL 的多家摘录可逐份查看；排名与命中家数不代表事实已核实。</div>
      {!result.results.length ? <section className="panel"><Empty title="搜索已完成，暂无结果">可以尝试更换关键词或放宽域名限制。</Empty></section> : <div className="result-list">{result.results.map((r, index) => <article className="result-card" key={r.url}><div className="result-rank">{String(index + 1).padStart(2, '0')}</div><div className="result-content">
        <div className="result-source"><span>{new URL(r.url).hostname}</span><div>{r.sources.map(p => <span className="source-tag" key={p}>{providerName[p]}</span>)}</div></div>
        <h3><a href={r.url} target="_blank" rel="noopener noreferrer">{r.title || r.url}<ExternalLink size={14}/></a></h3><p>{r.snippet || '此来源没有返回摘要。'}</p>
        <div className="result-actions"><button className="text-button" onClick={() => { setPage(null); setReader({ collection: result.collection_id, urls: [r.url], title: '来源证据' }); }}>查看 {r.evidence.length} 份来源摘录</button><button className="text-button" disabled={!!reading} onClick={() => void readPage(r.url)}>{reading === r.url ? <Spinner/> : <FileText size={14}/>}读取正文<ArrowRight size={13}/></button></div>
      </div></article>)}</div>}
      {result.next_offset !== null && <div className="panel-footer"><span>其余结果已保存，无需重新搜索</span><button className="button" disabled={loadingMore || busy} onClick={() => void loadMore()}>{loadingMore && <Spinner/>}加载更多结果</button></div>}
    </>}
    {reader && <EvidenceReader key={`${reader.collection}-${reader.urls[0]}`} {...reader} close={() => setReader(null)}/>}
    {page && <section className="panel source-reader"><div className="panel-heading"><div><h2>网页正文</h2><p>{page.url}</p></div><button className="button small" onClick={() => setPage(null)}>收起</button></div><pre>{page.content}</pre></section>}
  </div>;
}
