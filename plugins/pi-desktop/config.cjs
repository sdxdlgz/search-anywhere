const fs = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { SearchError, gatewayUrl } = require('./client.cjs');

function validate(input, domains) {
  const gateway = gatewayUrl(String(input.gateway || '').trim(), domains);
  const token = String(input.token || '').trim();
  if (token && !/^sa_[A-Za-z0-9_-]{16,509}$/.test(token)) throw new SearchError('configuration', '请填写有效的 sa_ 搜索访问凭证。');
  const profile = String(input.profile || '').trim();
  if (profile.length > 50) throw new SearchError('configuration', '预设 ID 不能超过 50 个字符。');
  const timeoutSeconds = Number(input.timeoutSeconds ?? 200);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) {
    throw new SearchError('configuration', '总等待时间须为 30–600 秒的整数。');
  }
  return { gateway, token, profile, timeoutSeconds };
}

class Config {
  constructor(directory, manifest, defaults = require('./defaults.json')) {
    this.file = join(directory, 'connection.json');
    this.directory = directory;
    this.manifest = manifest;
    this.defaults = defaults;
    this.tail = Promise.resolve();
  }
  async read() {
    try { return validate(JSON.parse(await fs.readFile(this.file, 'utf8')), this.manifest.net.domains); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new SearchError('configuration', '插件配置无法读取，请重新保存连接设置。');
      return validate({ gateway: this.defaults.gateway, profile: '', timeoutSeconds: 200 }, this.manifest.net.domains);
    }
  }
  async ready() {
    const config = await this.read();
    if (!config.token) throw new SearchError('configuration', '请先在 Search Anywhere 插件设置中保存搜索访问凭证。');
    return config;
  }
  async status() {
    let connection;
    let warning;
    try { connection = await this.read(); }
    catch { connection = validate({ gateway: this.defaults.gateway }, this.manifest.net.domains); warning = '原配置无法读取或不符合当前安装包，请重新填写并保存访问凭证。'; }
    const { token, ...publicConfig } = connection;
    return { ...publicConfig, configured: !!token, tokenMask: token ? `${token.slice(0, 6)}••••••${token.slice(-4)}` : '', allowedDomains: this.manifest.net.domains, ...(warning ? { warning } : {}) };
  }
  save(input) {
    const update = this.tail.then(async () => {
      let previous;
      try { previous = await this.read(); }
      catch (error) {
        if (!input.token?.trim() && !input.clearToken) throw error;
        previous = validate({ gateway: this.defaults.gateway }, this.manifest.net.domains);
      }
      const config = validate({ ...previous, ...input, token: input.clearToken ? '' : (input.token?.trim() || previous.token) }, this.manifest.net.domains);
      if (config.gateway !== previous.gateway && previous.token && !input.token?.trim() && !input.clearToken) {
        throw new SearchError('configuration', '更换网关地址时请重新填写访问凭证。');
      }
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return this.status();
    });
    this.tail = update.catch(() => {});
    return update;
  }
}
module.exports = { Config, validate };
