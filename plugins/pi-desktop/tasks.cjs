const { randomUUID } = require('node:crypto');
const { SearchError } = require('./client.cjs');

class Tasks {
  constructor({ firstWaitMs = 8000, pollWaitMs = 20000, ttlMs = 600000, maxActive = 4, maxTasks = 32 } = {}) {
    Object.assign(this, { firstWaitMs, pollWaitMs, ttlMs, maxActive, maxTasks });
    this.items = new Map();
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref();
  }
  prune() {
    for (const [id, task] of this.items) {
      if (Date.now() - task.updated < this.ttlMs) continue;
      task.controller.abort();
      this.items.delete(id);
    }
  }
  async start(owner, operation, signal) {
    if (!owner) throw new SearchError('session_required', '搜索工具需要有效的会话。');
    if (signal?.aborted) throw new SearchError('cancelled', '搜索任务已取消。');
    this.prune();
    if ([...this.items.values()].filter(t => t.state === 'pending').length >= this.maxActive || this.items.size >= this.maxTasks) {
      throw new SearchError('busy', '插件任务已达上限，请先领取已有结果或稍后重试。');
    }
    const task = { id: randomUUID(), owner, state: 'pending', updated: Date.now(), controller: new AbortController() };
    this.items.set(task.id, task);
    task.done = Promise.resolve().then(() => operation(task.controller.signal)).then(
      value => { if (task.state === 'pending') { task.state = 'completed'; task.value = value; } },
      error => { if (task.state === 'pending') { task.state = 'failed'; task.error = error; } },
    ).finally(() => { task.updated = Date.now(); });
    try { return await this.wait(task, this.firstWaitMs, signal); }
    finally { if (task.state !== 'pending') this.items.delete(task.id); }
  }
  async poll(owner, input, signal) {
    this.prune();
    const task = this.items.get(input?.task_id);
    if (!task || task.owner !== owner) throw new SearchError('task_not_found', '任务不存在或已过期；插件重启会清除临时任务。');
    if (input.action === 'cancel') {
      if (task.state === 'pending') { task.state = 'cancelled'; task.controller.abort(); task.updated = Date.now(); }
      return this.result(task);
    }
    if (input.action && input.action !== 'wait') throw new SearchError('validation_error', '任务操作必须为 wait 或 cancel。');
    return this.wait(task, this.pollWaitMs, signal);
  }
  result(task) {
    if (task.state === 'completed') return task.value;
    if (task.state === 'failed') throw task.error;
    if (task.state === 'cancelled') return { status: 'cancelled', task_id: task.id };
    return { status: 'pending', task_id: task.id, next_tool: 'search_task', instruction: 'Call search_task with this task_id and action=wait until complete. Do not repeat the original search or infer an answer from this pending response.' };
  }
  async wait(task, milliseconds, signal) {
    let timer;
    const cancel = () => { if (task.state === 'pending') { task.state = 'cancelled'; task.controller.abort(); } };
    let taskAbort;
    const aborted = new Promise((_, reject) => {
      taskAbort = () => { cancel(); reject(new SearchError('cancelled', '搜索任务已取消。')); };
    });
    // The listener only spans this tool wait; a pending response intentionally leaves its HTTP task running.
    signal?.addEventListener('abort', taskAbort, { once: true });
    try {
      if (signal?.aborted) taskAbort();
      await Promise.race([task.done, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); }), aborted]);
      return this.result(task);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', taskAbort); }
  }
  close() {
    clearInterval(this.timer);
    for (const task of this.items.values()) task.controller.abort();
    this.items.clear();
  }
}
module.exports = { Tasks };
