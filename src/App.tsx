import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, Check, ChevronRight, CircleHelp, FlaskConical, KeyRound, LayoutDashboard, ListFilter, LogOut, Menu, Plug, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import type { Dashboard, KeyPublic, Profile, RequestLog, Settings, TokenPublic } from '../shared/types';
import { api, json } from './api';
import { Brand, Spinner } from './components';
import { Overview } from './pages/Overview';
import { Keys, KeyDialog } from './pages/Keys';
import { Profiles } from './pages/Profiles';
import { Logs, Playground } from './pages/Activity';
import { Connections } from './pages/Connections';
import type { UsagePatch } from './usage-refresh';

type Page = 'overview' | 'keys' | 'profiles' | 'logs' | 'playground' | 'connections';
const pages = [
  { id: 'overview', label: '概览', icon: LayoutDashboard, section: 'WORKSPACE' },
  { id: 'keys', label: '供应商与密钥', icon: KeyRound },
  { id: 'profiles', label: '搜索预设', icon: SlidersHorizontal },
  { id: 'logs', label: '用量与日志', icon: Activity },
  { id: 'playground', label: '搜索测试', icon: FlaskConical, section: 'DEVELOPER' },
  { id: 'connections', label: '客户端接入', icon: Plug },
] as const;
export type Data = { dashboard: Dashboard; keys: KeyPublic[]; profiles: Profile[]; settings: Settings; tokens: TokenPublic[]; logs: RequestLog[] };
export type RunAction = (task: () => Promise<unknown>, message?: string) => Promise<boolean>;

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <main className="login-shell"><section className="login-story"><Brand/><div><span className="eyebrow">ONE SEARCH. MORE PERSPECTIVES.</span><h1>让每一次搜索，<br/>看得更全面。</h1><p>汇聚五家搜索服务，保留每份来源证据。<br/>一个入口，管理你的搜索能力。</p><div className="login-providers"><span>exa</span><span>∥ parallel</span><span>tavily</span></div></div><small>SEARCH ANYWHERE / PERSONAL SEARCH GATEWAY</small></section>
    <section className="login-form-wrap"><form className="login-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await api('/session', { method: 'POST', body: json({ token }) }); setToken(''); await onLogin(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      <span className="eyebrow">WELCOME BACK</span><h2>登录管理控制台</h2><p>管理密钥、搜索策略与每一次调用。</p><label className="field">管理员口令<input name="admin-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder="输入管理员口令" required autoFocus/></label>
      {error && <div role="alert" className="notice warn">{error}</div>}<button className="button primary full" disabled={busy}>{busy ? <Spinner/> : <>进入控制台<ArrowRight size={17}/></>}</button>
      <div className="login-help"><ShieldCheck size={18}/><p>首次启动生成的口令保存在服务器的 <code>.data/admin-token.txt</code>。也可在项目目录运行 <code>npm run admin:token</code> 查看。</p></div>
    </form></section></main>;
}

export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null), [data, setData] = useState<Data | null>(null);
  const [page, setPage] = useState<Page>('overview'), [menu, setMenu] = useState(false);
  const [keyDialog, setKeyDialog] = useState<KeyPublic | 'new' | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null), [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    const [dashboard, keys, profiles, settings, tokens, logs] = await Promise.all([api<Dashboard>('/dashboard'), api<KeyPublic[]>('/keys'), api<Profile[]>('/profiles'), api<Settings>('/settings'), api<TokenPublic[]>('/tokens'), api<RequestLog[]>('/logs')]);
    setData({ dashboard, keys, profiles, settings, tokens, logs });
  }, []);
  useEffect(() => { void api('/session').then(async () => { setAuth(true); await load(); }).catch(() => setAuth(false)); }, [load]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 3500); return () => clearTimeout(timer); }, [toast]);
  const run: RunAction = async (task, message = '已保存') => {
    try { await task(); await load(); if (message) setToast({ text: message, error: false }); return true; }
    catch (error) { setToast({ text: (error as Error).message, error: true }); return false; }
  };
  const navigate = (value: Page) => { setPage(value); setMenu(false); window.scrollTo(0, 0); };
  const updateUsage = (id: string, patch: UsagePatch) => setData(current => current ? { ...current, keys: current.keys.map(key => key.id === id ? { ...key, ...patch } : key) } : current);
  if (auth === null) return <div className="boot"><Brand/><Spinner/></div>;
  if (!auth) return <Login onLogin={async () => { await load(); setAuth(true); }}/>;
  if (!data) return <div className="boot"><Spinner/><p>正在加载控制台…</p><button className="button" onClick={() => void load().catch(e => setToast({ text: e.message, error: true }))}>重试</button></div>;
  const active = pages.find(p => p.id === page)!;
  let content: ReactNode;
  switch (page) {
    case 'overview': content = <Overview data={data} onAdd={() => setKeyDialog('new')} navigate={navigate}/>; break;
    case 'keys': content = <Keys data={data} run={run} updateUsage={updateUsage} onAdd={() => setKeyDialog('new')} onEdit={setKeyDialog}/>; break;
    case 'profiles': content = <Profiles data={data} run={run}/>; break;
    case 'logs': content = <Logs initial={data.logs}/>; break;
    case 'playground': content = <Playground data={data} reload={load}/>; break;
    case 'connections': content = <Connections data={data} run={run}/>; break;
  }
  return <div className="app-shell">{menu && <button className="sidebar-overlay" aria-label="关闭导航" onClick={() => setMenu(false)}/>}
    <aside className={`sidebar ${menu ? 'open' : ''}`}><Brand/><div className="workspace-label"><span className="workspace-avatar">S</span><span>我的搜索工作台<small>Personal workspace</small></span><ChevronRight size={14}/></div>
      <nav aria-label="主导航">{pages.map(item => <div key={item.id}>{'section' in item && <div className="nav-section">{item.section}</div>}<button className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={18}/>{item.label}{item.id === 'keys' && <span className="nav-count">{data.keys.length}</span>}</button></div>)}</nav>
      <div className="sidebar-bottom"><div className="local-note"><span className="status-dot"/><span>本地网关已连接<small>HTTP + MCP · v0.2.2</small></span></div><button className="nav-item" onClick={() => navigate('connections')}><CircleHelp size={18}/>接入与使用说明</button><button className="nav-item" onClick={async () => { await api('/session', { method: 'DELETE' }); setAuth(false); setData(null); }}><LogOut size={18}/>退出登录</button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMenu(true)}><Menu size={20}/></button><span>工作台</span><ChevronRight size={13}/><strong>{active.label}</strong></div><div className="top-actions"><span className="online-pill"><i/>运行中</span><span className="top-divider"/><button className="icon-button" title="只刷新本地页面数据，不查询官方用量" aria-label="刷新数据" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await load(); setToast({ text: '页面数据已刷新，未查询官方用量', error: false }); } catch (e) { setToast({ text: (e as Error).message, error: true }); } finally { setRefreshing(false); } }}><RefreshCw size={17} className={refreshing ? 'spin' : ''}/></button><span className="user-avatar">S</span></div></header>
      <main className="main-content">{content}</main><footer className="footer"><span>SEARCH ANYWHERE <span className="footer-dot">·</span> YOUR SEARCH, CONNECTED.</span><span>密钥加密存储 <ShieldCheck size={13}/></span></footer>
    </div>
    {keyDialog && <KeyDialog initial={keyDialog === 'new' ? undefined : keyDialog} run={run} onClose={() => setKeyDialog(null)}/>}
    {toast && <div className={`toast ${toast.error ? 'warn' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={18}/> : <Check size={18}/>}<span>{toast.text}</span><button aria-label="关闭提示" className="icon-button" onClick={() => setToast(null)}><X size={15}/></button></div>}
  </div>;
}
