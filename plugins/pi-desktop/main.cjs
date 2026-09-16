const { Config } = require('./config.cjs');
const { Tasks } = require('./tasks.cjs');
const { request, SearchError } = require('./client.cjs');
const { tools } = require('./tools.cjs');

let config;
let tasks;
async function execute(tool, input, context) {
  const owner = context?.sessionId;
  if (tool.name === 'search_task') return tasks.poll(owner, input, context?.signal);
  const connection = await config.ready();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SearchError('validation_error', '工具参数必须为对象。');
  const args = { ...input };
  if (['search', 'fetch'].includes(tool.name) && args.profile === undefined && connection.profile) args.profile = connection.profile;
  return tasks.start(owner, signal => request(connection, tool.endpoint, args, signal), context?.signal);
}

async function onLoad() {
  config = new Config(await pi.plugin.getDataPath(), pi.plugin.getManifest());
  tasks = new Tasks();
  await pi.commands.register({ id: 'connection', title: 'Search Anywhere：连接设置', keywords: ['search', '搜索', '设置'], run: () => pi.ui.openPanel() });
  for (const tool of tools) {
    const { endpoint, ...descriptor } = tool;
    await pi.agent.registerTool({ ...descriptor, execute: (input, context) => execute(tool, input, context) });
  }
}

async function onPanelInvoke(channel, payload = {}) {
  if (channel === 'connection.status') return config.status();
  if (channel === 'connection.save') return config.save(payload);
  if (channel === 'connection.clear') {
    const result = await config.save({ clearToken: true });
    tasks.close(); tasks = new Tasks();
    return result;
  }
  if (channel === 'connection.test') {
    const connection = await config.ready();
    try {
      await request(connection, '/v1/results', { collection_id: '00000000-0000-4000-8000-000000000000' }, undefined, { timeoutMs: 5000 });
    } catch (error) {
      if (error.code !== 'not_found' || error.status !== 404) throw error;
    }
    return { ok: true, message: '连接与访问凭证有效。本次只读取结果接口，没有调用搜索供应商。' };
  }
  throw new SearchError('unsupported', '未知的插件操作。');
}

async function onUnload() {
  tasks?.close();
  await pi.commands.unregister('connection');
  for (const tool of tools) await pi.agent.unregisterTool(tool.name);
}
module.exports = { onLoad, onUnload, onPanelInvoke };
