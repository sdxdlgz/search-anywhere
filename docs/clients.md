# 客户端接入

[返回 README](../README.md) · [使用指南](usage.md) · [部署与配置](deployment.md)

Search Anywhere 提供搜索工具服务。模型推理服务单独配置；客户端负责将工具声明发送给支持工具调用的模型，并执行模型请求的搜索操作。

## 准备连接参数

在控制台 **客户端接入** 中创建搜索访问凭证。建议每个应用使用独立凭证，便于追踪与删除；完整凭证只在创建时显示一次。管理员口令不能替代搜索访问凭证。

本文使用 `https://search.example.com` 作为示例地址，`YOUR_SEARCH_TOKEN` 作为凭证占位符。

| 参数 | 值 |
| --- | --- |
| MCP 地址 | `https://search.example.com/mcp` |
| 传输方式 | Streamable HTTP |
| HTTP 请求头 | `Authorization: Bearer YOUR_SEARCH_TOKEN` |
| 工具调用超时 | 建议至少 180 秒 |

本机服务可使用 `http://localhost:8765`。地址必须从实际执行工具的机器访问得到：手机、远程 Agent、网页应用后端或另一容器中的 `localhost` 不指向网关主机。

下面的配置依据各客户端文档及公开实现整理。客户端版本和部署方式可能影响入口与超时限制，首次接入应完成一次真实工具调用验证。

## 按访问凭证查看用量

**客户端接入 → 搜索访问凭证** 显示每个 `sa_…` 凭证的累计与本月（UTC）统计，点击页面 **刷新** 更新。统计按不可变的凭证 ID 归属，同名凭证分别计数。删除后凭证及其统计行从此列表移除，历史调用记录和全局用量、费用保留；同名新凭证从零计数。接口 `GET /api/tokens` 在每条凭证中附带 `usage.lifetime`、`usage.month` 和 `usage.month_start`，需要管理员登录。`DELETE /api/tokens/:id` 永久删除指定凭证，重复删除仍返回成功。

- **请求次数**：进入检索流程的搜索和正文读取，包含成功、部分成功、失败、进行中和缓存命中。请求格式、鉴权或预设检查未通过时不计入；正文请求在进入检索流程前因并发容量等被拒绝也不计入。
- **上游调用**：每次实际搜索或正文尝试分别计数，包括多渠道并行、重试、免费 MCP 及限流后的 API 补充。命中缓存或合并相同的并发查询可增加请求数而不增加上游调用。
- **已记录消耗**：美元费用区分上游报告与内置计费估算，各供应商 credits 分别展示，`≈` 表示估算。免费调用、费用未知与尚未结束的调用另列。免费额度扣减的 credits 仍是消耗；未知价格不会显示为免费，记录金额也不等同于官方应付账单。

MCP 初始化、工具列表、读取已有结果和证据分页、官方额度刷新不计入搜索请求。月统计分别按请求、上游调用的 UTC 发生时间计算；跨月结束的调用仍归入开始所在月份。控制台测试使用管理员身份，不归到某个客户端凭证。

历史清理保留凭证归属与计费记录，备份恢复也保留统计。升级前的记录仅在仍有明确的结果集合归属时补计；旧缓存请求、无结果的失败请求或已清理且无法确定归属的记录不会按名称猜测分配。

## 通用 MCP JSON

支持该格式的客户端可导入：

```json
{
  "mcpServers": {
    "search-anywhere": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SEARCH_TOKEN"
      }
    }
  }
}
```

网关提供 `search`、`search_results`、`get_evidence` 和 `fetch`。客户端可能给工具名称添加服务器前缀。

## Claude Code

添加用户级配置：

```bash
claude mcp add --transport http --scope user --header "Authorization: Bearer YOUR_SEARCH_TOKEN" search-anywhere https://search.example.com/mcp
```

重启后使用 `/mcp` 检查连接。较长的搜索调用建议将启动环境中的 `MCP_TOOL_TIMEOUT` 设为 `180000`，单位为毫秒。

[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)

## Codex

在运行 Codex 的主机上，将以下配置合并到 `~/.codex/config.toml`，然后重启客户端：

```toml
[mcp_servers.search-anywhere]
url = "https://search.example.com/mcp"
http_headers = { Authorization = "Bearer YOUR_SEARCH_TOKEN" }
startup_timeout_sec = 20
tool_timeout_sec = 180
```

使用环境变量保存凭证时，可将 `http_headers` 一行替换为 `bearer_token_env_var = "SEARCH_ANYWHERE_TOKEN"`；该变量必须在 Codex 进程启动时可见。CLI 中可用 `/mcp` 检查连接。

[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## Hermes

将以下内容合并到 `~/.hermes/config.yaml` 的 `mcp_servers` 下，重启对应进程：

```yaml
mcp_servers:
  search-anywhere:
    url: "https://search.example.com/mcp"
    headers:
      Authorization: "Bearer YOUR_SEARCH_TOKEN"
    timeout: 180
    connect_timeout: 20
```

模型供应商设置与 MCP 设置相互独立。[Hermes MCP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)

## LobeChat / LobeHub

1. 在设置的技能页面或助理设置中打开 **添加自定义技能 / MCP**。
2. 导入通用 JSON，或选择 **Streamable HTTP** 并填写 MCP 地址。
3. 选择 API Key / Bearer 认证时，只填凭证本身；使用自定义请求头时填写完整的 `Authorization: Bearer …`。
4. 测试连接并安装，然后在对应助理中启用该技能。

菜单名称取决于版本。安装到工作区后仍需要为助理启用。[自定义 MCP 文档](https://github.com/lobehub/lobe-chat/blob/main/docs/usage/community/custom-mcp.zh-CN.mdx)

## Kelivo

1. 进入设置中的 MCP 页面，导入通用 JSON 或新增 HTTP / Streamable HTTP 服务。
2. 地址填写 MCP URL，自定义请求头名为 `Authorization`，值为 `Bearer YOUR_SEARCH_TOKEN`。
3. 连接后，在需要使用搜索的助手或会话中启用工具。
4. 在 MCP 超时设置中将工具调用超时设为至少 180 秒。

应通过 MCP 入口接入，不能将网关凭证填入内置 Tavily 或 Exa 配置栏。[Kelivo 配置格式](https://github.com/Chevey339/kelivo/blob/master/lib/core/services/mcp/mcp_config_import.dart)

## DeepSeek Harness（DSH）

使用官方 `@deepseek-ai/dsh-mcp-client` 插件，将以下片段合并到当前 profile 的 `cordis.patch.yml`。默认路径为 `~/.dsh/profiles/<profile>/cordis.patch.yml`；设置 `DSH_HOME` 时以该目录为准。

```yaml
- insert:
    - id: mcp-search-anywhere
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: search-anywhere
        transport: streamable-http
        url: https://search.example.com/mcp
        headers:
          Authorization: "Bearer YOUR_SEARCH_TOKEN"
        toolCallTimeoutMs: 180000
```

运行环境需要包含匹配版本的官方插件。保留已有 patch 内容，重载配置或重启后确认工具出现。

[官方 MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) · [Profile patch 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md)

## Pi

Pi 核心不内置 MCP；可通过支持远程 HTTP 的 MCP 扩展连接网关，或编写 Pi 扩展调用下面的 HTTP API。本项目目前未提供专用 Pi 扩展。

已有 MCP 扩展时，按该扩展的格式设置网关地址和 Authorization 请求头。[Pi 扩展机制](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)

### PI-Desktop 内置 MCP

推荐安装 [Search Anywhere 独立插件](../plugins/pi-desktop/README.md)。插件直接调用 HTTP API，长搜索通过任务等待领取结果，避开内置 MCP 的短超时，也无需修改应用安装包。它提供连接设置和脱敏凭证显示，普通应用升级会保留插件配置。启用后停用同名 MCP 服务，避免混用入口。

PI-Desktop 与 Pi CLI 扩展的实现不同。部分 PI-Desktop 0.14.8 构建把握手时的 10 秒超时保留在 HTTP transport 中，用于后续全部请求；即使工具层超时更长，耗时超过约 10 秒的搜索也会被客户端中止。此时 Nginx 可记录 499，网关旧版本把取消与超时都标为 `timeout / 504`。

需要在客户端 HTTP transport 中按调用类型区分超时：握手使用连接超时，`tools/call` 使用工具调用超时，并将后者设为至少 180 秒。只有提高网关预设超时或发送保活信息不能修复这种固定总时限。使用已修复的客户端构建后，重连 MCP 再测试覆盖搜索；不必将 Exa 降为快速模式。[错误排查](provider-errors.md)

## HTTP API

所有接口均为 POST，使用 JSON 请求体和搜索访问凭证：

```bash
curl https://search.example.com/v1/search \
  -H "Authorization: Bearer $SEARCH_ANYWHERE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"SQLite WAL 模式如何处理并发读写？","profile":"coverage","max_results":10}'
```

执行前将凭证写入当前进程可读取的 `SEARCH_ANYWHERE_TOKEN` 环境变量。

| 路径 | 参数 | 用途 |
| --- | --- | --- |
| `/v1/search` | `query`；可选 `profile`、`max_results`、`per_provider_results`、`include_domains`、`exclude_domains` | 检索并返回结果集合 |
| `/v1/results` | `collection_id`；可选 `offset`、`limit` | 读取结果的后续页 |
| `/v1/evidence` | `collection_id`、`url`；可选 `offset`、`limit` | 按字符偏移读取逐来源证据 |
| `/v1/fetch` | `url`；可选 `profile`、`objective`（1–200 字符的研究问题） | 请求正文并保存结果集合；省略 objective 时使用通用页面阅读目标 |

搜索响应中的 `collection_id` 用于后续读取；结果分页的 `next_offset` 为 `null` 时已到末页。`max_results` 是展示页大小，不是整个结果集合的上限。结果与证据读取使用创建集合的同一访问凭证。

网关不提供模型 Chat Completions 接口，也不模拟供应商原生鉴权协议。只支持填写模型 API key 或固定搜索供应商 key 的应用，需要增加 HTTP 工具或 MCP 适配。

## 验证与排查

连接后确认可以发现四个工具，再执行一次搜索。例如：

> 使用 search-anywhere 的 search，profile 设为 coverage，检索 SQLite WAL 模式的并发机制。继续读取结果分页和关键来源正文，最后附引用链接。

在网关 **用量与日志** 中确认对应客户端产生调用记录。健康检查和工具列表只能证明连接/协议可用，不能验证上游检索质量。

| 现象 | 检查项 |
| --- | --- |
| 401 | 使用搜索访问凭证，检查是否删除，以及 Bearer 请求头是否完整 |
| 403 / Origin 被拒绝 | 核对 HTTPS 反向代理；浏览器跨源直连时按需配置 `SA_ALLOWED_ORIGINS` |
| 连接超时 | 检查实际工具执行端是否能访问 URL，特别是 localhost、容器网络和 SSH 隧道 |
| 工具调用约 60 秒中断 | 调整客户端工具超时与反向代理读取超时 |
| 已连接但模型不调用 | 确认当前助理启用了工具，模型及转发链支持工具调用，并显式指定该工具测试 |
| 结果条数较少 | 读取结果分页，检查上游提示及搜索预设；不要将首页数量当作全部结果 |

常规 API 查询提示和上游数量限制见[上游查询提示](search-warnings.md)。多轮检索、证据核对与结论生成由调用方完成，见[研究工作流](research-workflow.md)。
