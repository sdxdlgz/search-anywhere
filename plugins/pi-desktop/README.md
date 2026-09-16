# Search Anywhere for PI-Desktop

通过独立插件调用 Search Anywhere HTTP API，提供多供应商搜索、结果分页、逐来源证据和正文读取。无需修改 PI-Desktop 安装包；普通应用升级保留已安装插件及其私有配置。

## 构建与安装

在 Search Anywhere 仓库根目录运行，需 Node.js 24 和 Python 3：

```bash
python scripts/package-pi-plugin.py --gateway https://search.example.com
```

生成 `dist/pi-desktop/sdxdlgz.search-anywhere-0.1.0.piplug` 及 SHA-256 校验文件。打包过程只包含明确列出的代码文件，不读取本地访问凭证。包内只授权指定网关域名；换域名需重新打包并安装。默认不传 `--gateway` 时使用 `http://localhost:8765`。

1. PI-Desktop → 插件 → 从本地安装，选择 `.piplug` 包，启用插件并确认其工具、面板及网络权限。
2. 打开插件命令 **Search Anywhere：连接设置**，填写网关根地址和 `sa_…` 搜索访问凭证。可指定 `coverage` 预设，也可留空跟随网关默认值。
3. 保存后点击 **测试连接**。此按钮验证鉴权和结果读取接口，不产生上游搜索调用；真实检索需要在 Agent 对话中执行。
4. 停用原先同名的 Search Anywhere MCP 配置，避免混用入口。在 Agent 模式新开一轮对话，要求模型使用 Search Anywhere 搜索。

原始源码目录中的清单是打包模板，请安装生成的 `.piplug`；需要开发加载时先解压安装包，再选择解压后的目录。

## 工具与长任务

| 工具 | 用途 |
| --- | --- |
| `search` | 多供应商检索，返回原始网关结果和 `collection_id` |
| `search_results` | 根据 `next_offset` 继续读取结果页 |
| `get_evidence` | 按字符偏移读取逐来源摘录、正文 |
| `fetch` | 通过网关读取网页正文 |
| `search_task` | 等待或取消未完成的任务 |

PI-Desktop 会给工具加插件命名空间，模型看到的实际名称可能包含插件 ID。

PI-Desktop 0.14.8 的内置 HTTP MCP 存在约 10 秒的传输层超时问题，插件工具本身另有约 110 秒执行上限。本插件的 HTTP 请求在独立插件进程中运行：8 秒内完成则直接返回，较慢则返回 `status: pending` 和 `task_id`。模型调用 `search_task`，每次最多等 20 秒，直至拿到完整网关响应。**等待不重复提交搜索，也不会增加上游调用量。**

总网络等待时间默认 200 秒，可设置为 30–600 秒；网关预设、反向代理自身的期限仍然有效。插件不缩短搜索模式、不降低每家返回数量，也不把部分失败伪装为完整结果。网关原有调用量和费用统计按使用的访问凭证记录。

临时任务按 PI-Desktop 会话隔离，最多 4 个进行中、32 个保留任务，完成后保留 10 分钟供重复领取。停止当前等待会取消对应 HTTP 请求，也可用 `search_task` 的 `cancel` 操作取消。退出应用、禁用或重载插件会取消进行中的任务；已保存到网关的集合仍按网关保留策略存在。插件工具受宿主规则限制，仅在 Agent 模式可用。

## 配置与凭证

插件 ID 固定为 `sdxdlgz.search-anywhere`，连接配置写入宿主提供的插件私有数据目录 `connection.json`，与应用和插件代码分开。输入框使用密码模式，保存后不回填明文，只显示首尾掩码。留空保存保留已有凭证；清除凭证同时取消进行中的任务。

**私有配置文件不是加密凭证库。** 在支持 POSIX 权限的平台以 `0600` 写入，Windows 继承该用户数据目录的 ACL。不要公开该文件；迁移机器时需要通过自己的安全方式迁移配置或重新填写。源码、安装包和普通插件设置中不包含真实 token。

请求使用插件进程的 Node HTTP fetch，以支持跨工具等待的请求与取消信号；目标限制为清单授权的网关，拒绝重定向，凭证不出现在工具参数、结果或日志。只支持 HTTPS 远程网关和 HTTP 本机地址。

## 兼容与验证

按 PI-Desktop 0.14.8 插件接口实现。插件 API 若发生不兼容变化，仍可能需要升级插件；它不会自动为任意未来宿主版本修补程序文件。

需求验收覆盖：四个 HTTP 操作与部分结果保留；慢任务、重复等待、跨会话拒绝、取消、超时和恢复；无效配置、鉴权错误、非 JSON、响应大小、重定向；配置持久化和脱敏；ZIP 根目录、store 压缩、校验和及凭证排除。仓库 `npm test` 运行自动化用例。真实宿主加载和设置面板检查记录在交付验证中。

接口依据：[插件开发指南](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)、[运行时实现](https://github.com/vastsa/PI-Desktop/blob/main/apps/desktop/electron/main/plugin-runtime.ts)。
