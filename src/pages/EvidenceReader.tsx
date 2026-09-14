import { useEffect, useState } from 'react';
import type { EvidenceResponse } from '../../shared/types';
import { api, date, json } from '../api';
import { providerName, Spinner } from '../components';

export function EvidenceReader({ collection, urls, title, close }: { collection: string; urls: string[]; title: string; close: () => void }) {
  const [url, setUrl] = useState(urls[0]);
  const [value, setValue] = useState<EvidenceResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setValue(null); setBusy(true); setError('');
    api<EvidenceResponse>('/evidence', { method: 'POST', body: json({ collection_id: collection, url }) })
      .then(v => { if (active) setValue(v); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [collection, url]);
  const more = async () => {
    if (!value || value.next_offset === null) return;
    setBusy(true); setError('');
    try {
      const next = await api<EvidenceResponse>('/evidence', { method: 'POST', body: json({ collection_id: collection, url, offset: value.next_offset }) });
      setValue({ ...next, offset: 0, evidence: next.evidence.map((e, i) => ({ ...e, snippet: value.evidence[i].snippet + e.snippet, content: (value.evidence[i].content || '') + (e.content || '') })) });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="panel source-reader" aria-busy={busy}>
    <div className="panel-heading"><div><h2>{title}</h2><p>同一网页的各渠道版本 · 保留原始归属，不代表已核实</p></div><button className="button small" onClick={close}>收起</button></div>
    {urls.length > 1 && <label className="field evidence-select">选择网页版本<select value={url} disabled={busy} onChange={e => setUrl(e.target.value)}>{urls.map(u => <option key={u}>{u}</option>)}</select></label>}
    {error && <p className="notice warn" role="alert">{error}</p>}
    {value?.evidence.map((e, i) => <article className="evidence-entry" key={`${e.provider}-${e.rank}-${i}`}>
      <div className="evidence-meta"><strong>{providerName[e.provider]} · {e.mode}</strong><span>原始排名 {e.rank} · 收集于 {date(e.retrieved_at)}</span></div>
      <a className="text-link" href={e.url} target="_blank" rel="noopener noreferrer">{e.url}</a>
      <p>{e.title}{e.published_at ? ` · 发布于 ${e.published_at}` : ''}{e.acquired_at ? ` · 索引于 ${e.acquired_at}` : ''}</p>
      {e.truncated && <p className="text-warn">此版本已被上游或存储限制截断，需要另行获取剩余原文。</p>}
      <pre>{e.snippet || '此片段无摘录。'}</pre>
      {e.content && e.content !== e.snippet && <details><summary>同时返回的正文</summary><pre>{e.content}</pre></details>}
    </article>)}
    <div className="panel-footer"><span>集合 {collection.slice(0, 8)} · 从本地读取，不新增上游调用</span>{busy ? <Spinner/> : value?.next_offset !== null && value && <button className="button small" onClick={() => void more()}>继续读取证据</button>}</div>
  </section>;
}
