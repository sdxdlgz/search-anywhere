const byId = id => document.getElementById(id);
const invoke = (channel, payload) => window.pluginBridge.invoke(channel, payload);
function display(state) {
  byId('gateway').value = state.gateway;
  byId('profile').value = state.profile;
  byId('timeout').value = state.timeoutSeconds;
  byId('token').value = '';
  byId('token-note').textContent = state.configured ? `已保存 ${state.tokenMask}；留空保留，填写则替换。` : '填写网关签发的搜索访问凭证。';
  byId('domain-note').textContent = `此安装包允许的域名：${state.allowedDomains.join('、')}`;
  byId('badge').textContent = state.configured ? '已配置' : '待配置';
  byId('clear').hidden = !state.configured;
  if (state.warning) byId('feedback').textContent = state.warning;
}
async function action(work) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  document.body.dataset.busy = 'true';
  byId('feedback').textContent = '';
  try { await work(); byId('feedback').dataset.error = 'false'; }
  catch (error) { byId('feedback').textContent = error.message || '操作失败，请重试。'; byId('feedback').dataset.error = 'true'; }
  finally { buttons.forEach(button => { button.disabled = false; }); delete document.body.dataset.busy; }
}
byId('connection').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    display(await invoke('connection.save', { gateway: byId('gateway').value, token: byId('token').value, profile: byId('profile').value, timeoutSeconds: Number(byId('timeout').value) }));
    byId('feedback').textContent = '已保存。新工具调用立即使用此配置。';
  });
});
byId('test').addEventListener('click', () => void action(async () => {
  byId('feedback').textContent = '正在检查已保存的连接…';
  byId('feedback').textContent = (await invoke('connection.test')).message;
}));
byId('clear').addEventListener('click', () => void action(async () => {
  display(await invoke('connection.clear'));
  byId('feedback').textContent = '已清除凭证并取消未完成的任务。';
}));
void action(async () => display(await invoke('connection.status')));
