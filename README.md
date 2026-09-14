# Search Anywhere

中文搜索网关：并行调用 Exa、Parallel、Tavily、AnySearch、Keenable，保存完整的返回结果与逐来源摘录，通过 HTTP API / MCP 交给模型继续核对、补搜和组织答案。集中管理多 key、账号归属、搜索模式和用量。

**当前目标是覆盖与证据完整性。** 不按价格或延迟自动削减渠道；同一 URL 的多家命中只算一个网页，不代表多份独立佐证。网关收集和整理资料，事实判断及研究迭代由调用方模型完成。

模型请求继续走你已有的 newapi / CPA；搜索工具连接此网关。客户端需要支持自定义 HTTP 工具或 MCP，填写**网关地址 + 搜索访问凭证**。这个凭证不能直接填进只接受厂商固定地址的 Tavily / Exa key 输入框，也不会自动接管客户端的内置搜索。

## 启动

需要 Node.js 24 或以上。在项目目录执行：

```powershell
npm ci
npm run build
npm start
```

已安装依赖并构建过的这份工作目录，直接 `npm start` 即可。打开 <http://127.0.0.1:8765>。首次启动自动生成 `.data/admin-token.txt`；在另一个终端运行以下命令查看管理员口令，复制到登录页：

```powershell
npm run admin:token
```

服务不会将口令打印到启动日志。管理员登录会话有效期 24 小时。开发时用 `npm run dev`，前后端共用同一个端口。

## 第一次配置

1. **供应商与密钥**：选择供应商，填写名称、账号来源备注和 key。可每行一个、一次导入最多 50 个；一批共用来源备注，每个 key 按独立账号统计额度。批量名称自动编号，同渠道同名前缀后续导入接续已有最大编号；首次单条保留填写的名称，同名追加时自动编号。
2. key 以 AES-256-GCM 加密存储。保存后只返回首尾片段，例如 `exa-••••••••3456`，不提供明文查看或导出。账号可以填写邮箱或备注，之后可编辑。
3. **搜索预设**：选择“覆盖优先”，分别调整各供应商模式。每家检索数量和每页展示数量分开，另可调整正文策略、总超时、缓存时间。升级保留旧预设和默认设置；旧安装需手动将覆盖优先设为默认，或请求时传 `profile: "coverage"`。
4. **搜索测试**：先做一次真实搜索。密钥测试使用 `fast`，AnySearch 使用 `auto`，Keenable 使用 `realtime`，只尝试指定 key。测试与正文读取会消耗上游额度并写入日志。
5. **客户端接入**：为 Hermes、Codex 等分别生成搜索访问凭证。完整凭证仅创建时显示一次；保存后可独立撤销，通过客户端名称追踪调用。

当前预设初始值：

| 预设 | Exa | Parallel | Tavily | AnySearch | Keenable | 总超时 |
| --- | --- | --- | --- | --- | --- | --- |
| `coverage`（新安装默认） | deep-reasoning | advanced | advanced | auto | pro | 120 秒 |
| `fast` | fast | fast | fast | 关闭 | 关闭 | 8 秒 |
| `balanced` | auto | basic | basic | 关闭 | 关闭 | 15 秒 |
| `thorough` | deep | advanced | advanced | 关闭 | 关闭 | 45 秒 |

Parallel 默认采用“免费优先，限流后使用 API key”：普通预设先匿名调用官方 Search MCP，实际模式固定为 `fast`；遇到明确的限流才使用已有健康 key，按表中配置的模式补充。`advanced` 直接走 API，保留高强度检索；可在每个预设中选择“始终使用 API key”。旧预设的模式和默认选择不变，新增接入策略缺省为免费优先。`coverage` / `thorough` 初始为 advanced，`fast` / `balanced` 初始可使用免费入口。

免费入口无需 key，但只免去这条 Parallel 调用的费用，其他供应商仍按原规则使用额度。它没有公开承诺的固定剩余次数；网关不会显示虚构余额。免费入口返回条数由上游控制，匿名请求不能调整 mode / max_results / 域名策略；网关保留全部返回结果，再本地过滤域名，响应会提示限制。免费失败、超时、空结果或过滤后零结果不自动触发额度调用。

覆盖优先请求每家最多 100 条，适配器按接入上限调整为 Exa 100 / Parallel 40 / Tavily 20 / AnySearch 20 / Keenable 50；实际数量还受套餐、模式和命中数量限制，不能保证每家填满。每页展示 10 条，剩余结果保存在本地，无需重新搜索。默认关闭网关缓存，正文并行收集各家版本。旧预设维持每家 10 条、缓存 120 秒、正文依次回退。仅有部分供应商 key 时，可关闭尚未配置的供应商；否则响应明确标记 `partial: true`。

## 多 key 和聚合行为

- 每个供应商内部按健康 key 轮询。单 key 默认最大并发 2，可调整为 1–16；网关搜索与正文读取合计最多 24 个活跃请求。
- 停用、无效、冷却和并发已满的 key 被跳过。401 标记无效；402、403、429、5xx 按类型冷却，429 优先遵循 `Retry-After`。冷却后重新参与；管理页也可手动恢复。
- 每个供应商一次搜索最多尝试 2 个不同 key，密钥测试只尝试指定 key。不会为了重试自动切换到更贵的模式。
- 普通 Parallel 请求可先增加一次匿名 MCP 尝试；429 按 `Retry-After` 冷却（缺失时 60 秒，范围 1 秒至 1 小时），当前进程内的所有客户端共用冷却。冷却期间直接使用 key，期满重新优先免费；无 key 或每日上限耗尽则明确失败。免费请求使用稳定的调用方哈希关联搜索/正文，不轮换身份规避限流。密钥测试始终调用指定 key。
- 预设启用的供应商并行调用，在总截止时间内保留成功结果。全部失败返回明确错误；空结果仍是成功。失败渠道、数量限制和警告都写入响应。
- URL 去除追踪参数与片段，保留有意义的查询参数。`sources` 记录检索渠道，`evidence` 保留各版本的原始 URL、查询、模式、排名、收集时间、摘录及返回的正文。相同 URL 的不同摘录不覆盖；不按相似摘要删除结果。
- 域名限制在融合后再核验，排除规则优先。AnySearch 的域名条件，以及 Keenable 的多域名/排除条件在网关过滤，可能减少召回；响应提示按域名分别补搜。
- `unique_urls` 表示该渠道在本集合的不同 URL 数，`exclusive_urls` 表示本次仅此渠道找到的 URL 数，可观察新增渠道带来的资料增量；它们不代表信息独立性或真实准确率。
- 只有完整成功响应进入缓存；同一访问凭证的相同在途请求可合并。不跨凭证共享缓存；修改 key、预设或设置会使后续请求使用新配置。
- 覆盖预设的 `fetch` 并行收集全部启用渠道的正文版本并持久化；旧预设按供应商顺序回退。Keenable 使用 live 提取，其他渠道按各自提取接口行为；不能假定所有版本都来自同一抓取时间。
- Parallel 正文读取也遵循预设的免费/API 策略，并请求 `full_content: true`。约 25,000 字符是单次工具调用的总摘录预算，不能据此当成完整正文的统一上限。全文读取能补充已命中网页的细节，不能找回未被搜索命中的 URL；重要问题仍需 advanced、多角度补搜和模型核对。网关不会自动抓取每一条命中。

账号归属字段用于记录邮箱或账号来源，方便排查。当前采用“每个 key 对应独立账号”的使用方式：相同来源备注的 key 也分别贡献额度，概览只按供应商渠道汇总。修改归属或删除 key 后，历史调用保留当时的备注与脱敏片段。Exa 的管理凭证仍沿用原有按账号归属保存的配置方式。

密钥列表把同渠道、同账号归属放在一起：各组按首次添加的先后出现，组内按添加时间从早到晚排列；后补的同归属 key 会接在该组末尾。每条密钥下显示添加时间，悬停可查看含年份和秒的完整本地时间。此排序仅影响列表展示，搜索轮询和渠道额度统计沿用原逻辑。

## 用量与余额的口径

本地用量从网关首次调用开始记录，不包含绕过网关的调用。今日统计和每日上限按 **UTC** 计算，页面时间按浏览器时区显示。密钥表显示累计调用；日志按客户端、查询或账号搜索，展开查看每一次供应商尝试。

| 数据 | 实际含义 |
| --- | --- |
| 网关请求数 | 每次搜索、测试或正文请求各记一次，缓存命中也记一次 |
| 上游调用数 | 每次实际搜索、重试、正文提取分别计数；官方用量查询不计入这个数 |
| 已报告美元消费 | 仅汇总上游响应中的美元费用，未报告费用的调用不计入金额 |
| Tavily credits | 上游返回时标记“上游报告”；缺失时搜索按模式估算并单独标记 |
| Parallel SKU | 保留上游 `{name, count}` 用量单位，在调用明细展示；不换算成虚构美元价格 |
| Parallel 免费 MCP | 每次逻辑搜索/正文尝试计数，握手不另计；标记 `billing_source: free`、美元 0，不伪称上游已报告费用。免费失败与 API 补充分别写入日志，并计入每日调用上限 |
| Keenable credits | 保留 MCP 返回的 SKU、credits、paid 标记，区分免费/购买额度；与 Tavily credits 分开统计，不假定固定美元兑换率 |
| 官方额度快照 | 来自供应商查询接口，带同步时间，可能有账单延迟 |

供应商支持情况：

- **Tavily**：使用搜索 key 查询官方 `/usage`，密钥页保留 key 限额和对应账号套餐额度；概览显示 Tavily 总额度、套餐已用和剩余，不按来源备注分组。按量付费用量独立显示。这是额度，不是现金余额。[官方接口](https://docs.tavily.com/documentation/api-reference/endpoint/usage)
- **Exa**：使用 Team Management API 查询本月已用美元费用。需要在 Exa 开通该功能，并在高级配置里填写账号 Service Key 和搜索 key ID；缺少这些信息仍可搜索、统计本地用量。Service Key 按账号加密保存。批量导入时搜索 key ID 必须留空，保存后逐个编辑配置，避免多个 key 错用同一个 ID。[官方接口](https://exa.ai/docs/reference/team-management/get-api-key-usage)

  需要查询剩余余额时，可在该 key 的钥匙图标中配置官网会话 Cookie 与 Team ID，无需 Service Key。网关核对官网会话与搜索 key 的团队后，查询 `/api/get-credits` 和套餐接口，按美元显示余额、未结算账单与到期部分；同团队余额不重复累计。已配置 Cookie 时优先查询余额，移除后恢复原有管理接口。用户已在官网验证余额路径，服务器完整登录链路仍需本地填写 Cookie 后核验。[配置与验证说明](docs/exa-balance.md)
- **Parallel**：已接入官方 `GET /account/service/v1/balance`。在 key 的钥匙按钮打开“Parallel 余额授权”，点击“开始官网授权”，在官网选择对应组织并确认；仅申请 `balance:read`，自动加密保存与续期，无需手动提取 token。余额与待扣/占用金额分开显示，后付费组织单独标明，同授权组织只汇总一次。官方没有现有搜索 key 的组织反查接口，授权时需自行选对组织，界面明确显示这是授权组织余额。单个、批量、定时查询均可使用，失败保留旧快照；“移除本地授权”保留搜索 key，不替你在官网撤销其他会话。注册最高 80 美元的分档条件仍未确认，每月 5 美元的绑卡赠额与匿名免费 MCP 分开。[接口与免费额度核查](docs/parallel-balance.md)
- **AnySearch**：接入 REST 搜索与提取，使用自动路由。配置官网登录凭证后查询 `/api/user/billing/overview`，显示账号请求额度、官方剩余次数与重置周期；搜索 key 本身不能查询此接口。官网 access token 与 refresh token 续期已实测成功。[接入说明与核验记录](docs/anysearch-balance.md)
- **Keenable**：通过官方 MCP 调用，支持 `realtime` / `pro`，记录官方用量元数据。配置官网登录凭证后，通过 `/bff/organization/balance` 查询组织余额；普通搜索 key 无法直接查询该接口。已实测 access token 查询与 refresh token 续期均返回 200。[接入说明与核验记录](docs/keenable-balance.md)

Keenable 每条 key 的钥匙图标打开“登录凭证”：填写 refresh token，access token 可选。保存后会查询余额并核对搜索 key 与登录账号的官方组织是否一致。凭证按 key 加密保存，不按来源备注共享；留空保留，支持单独移除，搜索 key 继续可用。凭证获取位置：官网登录后 F12 → Application → Local Storage → app.keenable.ai → sb-…-auth-token。

AnySearch 同样从每条 key 的钥匙图标配置，支持只填 refresh token。凭证获取位置：官网登录后 F12 → Application → Local Storage → www.anysearch.com → search-template-auth-state → state → accessToken / refreshToken。保存后核对官网密钥列表中的完整 key，再接受账号额度；同一官方账号的额度只累计一次。单位为“次”，按官方返回值显示剩余与每日／每月重置周期，不与 credits 相加。

两家查询时都会在 access token 距到期不足一分钟时续期，遇到登录失效时最多续期重试一次，并立即加密保存返回的新 token 对。单个、所选批量和原有定时同步均可使用；刷新页面不续期。登录失效会暂停该凭证的自动查询并提示重新配置，保留已有额度快照与搜索状态。建议给网关使用独立网页登录会话，取出凭证后关闭官网页，避免浏览器和网关轮换同一 refresh token；官网退出登录可能撤销该会话。AnySearch 使用自身认证服务；Keenable 使用 Supabase。[Keenable 续期机制](https://supabase.com/docs/guides/auth/sessions)

Keenable 分别显示免费总额度、已计费消耗、免费剩余和付费余额，单位均为 credits，不等于搜索次数。渠道汇总根据官方组织的脱敏标识去重，采用最新快照；不同来源备注不会把同组织的额度重复累计，相同备注下的不同组织也不会合并。未配置、未返回或查询失败不记为零。[官方额度说明](https://docs.keenable.ai/credits)

自动同步默认每 30 分钟，后台每分钟检查到期项，每轮最多 10 个 key；可设置 0 关闭。手动同步随时可用。同步失败保留上次快照并显示错误。

**单个查询与批量查询分开：**

- 行内“查询用量”只查询这一把 key，只更新这一行；其他 key 的按钮保持可用。它不执行搜索，也不重新查询整批 key。
- 勾选密钥后点击“批量查询所选用量（N）”，只处理当前筛选内勾选的 1–100 把 key，最多同时查询 3 把，汇总显示成功、失败或未支持数量。全部成功后 5 秒、含失败或未支持项时 8 秒自动关闭提示，也可手动关闭；失败状态保留在对应行。批量复用单项接口，没有隐含的全账号扩展；单项失败不影响其他结果。
- 页顶“刷新数据”只重读本地数据库，完全不调用供应商用量接口。
- 密钥页显示自动同步状态，可单独暂停。定时同步独立于手动操作；同 key 正在查询时，其他请求复用在途查询。批次等待期间已手动刷新的 key 不再重复请求。

密钥表将“网关记录”与“官方用量快照”并列展示：累计调用次数、本月上游响应报告的 credits、本月本地估算，以及官方 key / 账号 / 按量用量和查询时间分别保留。本月按 UTC 自然月计算，仅包含本网关经过的调用。概览按每 key 独立账号累计已同步的套餐额度：例如 12 个账号各 1,000 credits，Tavily 总额度为 12,000 credits。未同步或未支持的额度标为未知、不视为零；查询失败保留旧快照并标注，按量消费不混入套餐合计。当前汇总包括该渠道所有已导入 key，不以启用状态筛除。

搜索响应报告消耗 1 credit，而官方 `/usage` 仍返回 0 时，页面同时显示两个值并提示差异，不把官方 0 强行改为 1。更新时间或统计范围可能不同，具体原因需要根据供应商记录确认。

新安装每日上游调用上限默认 0（不限），已有安装保留原设置。它限制**调用次数**，包含重试与正文读取，不是美元预算；未知消费不能当作免费，账单以供应商为准。

## HTTP API

所有 `/v1/*` 请求使用 `Authorization: Bearer <搜索访问凭证>`，不能用管理员口令或上游 key 替代。

```http
POST /v1/search
Authorization: Bearer YOUR_SEARCH_KEY
Content-Type: application/json

{"query":"SQLite WAL 的适用场景","profile":"coverage","max_results":10,"per_provider_results":100}
```

支持 `query`（必填，1–1,500 字符）、`profile`、`max_results`（每页 1–30）、`per_provider_results`（每家请求 1–100）、`include_domains` / `exclude_domains`（每组最多 20 个域名）。省略 `profile` 使用控制台默认值；省略数量使用预设。

响应保留 `request_id`、`results`、`providers`、`partial`、`cache_hit`、`duration_ms`。新增 `collection_id`、`total_results`、`next_offset`、`collected_at`、检索输入及预设快照 `scope`。每条结果包含 `sources` 与逐来源 `evidence`，排名分数 `score` 只供浏览排序，不是置信度。渠道结果与证据中的 `transport` 区分 `free_mcp` / `api`，`mode` 是实际模式；免费响应另带 `requested_mode`，数量上限未知时 `effective_limit: null`。`fallback_reason: free_rate_limited` 表示免费限流后补充，日志保留每次尝试。

后续读取均使用同一访问凭证，不新增上游调用：

| 接口 | 请求示例 | 行为 |
| --- | --- | --- |
| `POST /v1/results` | `{"collection_id":"集合 UUID","offset":10,"limit":10}` | 按 `next_offset` 读取剩余 URL，直到 null；limit 1–30 |
| `POST /v1/evidence` | `{"collection_id":"集合 UUID","url":"https://example.com/a","offset":0,"limit":8000}` | 逐渠道读取保留的摘录/正文；offset 按字符，limit 1–20,000；按 next_offset 继续 |

集合以访问凭证 ID 隔离，即使客户端名称相同也不能互读；管理员可读取全部集合。缓存命中生成新的 `request_id`，但保留原 `collection_id` 和证据时间。集合重启后仍可读，单纯删除缓存不删除证据。

```http
POST /v1/fetch
Authorization: Bearer YOUR_SEARCH_KEY
Content-Type: application/json

{"url":"https://sqlite.org/wal.html","profile":"coverage"}
```

覆盖正文返回集合及预览，使用 `/v1/evidence` 读取各版本；旧预设正文仍直接放在 `results[0].snippet`，同时新增持久化 `collection_id`，可以分页读取保留的完整文本。仅接受公网域名 HTTP/HTTPS URL，不接受 IP、内网名称或含用户密码的 URL。

结果页的摘录预览最多 1,800 字符，完整保留文本用 evidence 接口分段读取。每个上游响应限制 4 MB，超过则明确报该渠道失败；每份摘录与正文各保留最多 100,000 字符，已知截断标记 `truncated`，仅预览缩短标记 `preview_truncated`。上游自身未声明的删节无法检测。没有声称穷尽网页或全网；达到 `effective_limit` 时提示仍可能有更多结果。

错误格式为 `{"error":{"code":"...","message":"..."}}`；常见状态包括 400 参数错误、401 无效访问凭证、429 网关并发满、503 全部供应商失败。单家故障且有结果时 HTTP 200、`partial: true`，通过 `providers` 查看原因。

## MCP 接入

地址 `http://127.0.0.1:8765/mcp`，传输 **Streamable HTTP**，提供 `search`、`search_results`、`get_evidence`、`fetch` 四个工具。使用与 HTTP API 相同的搜索访问凭证。未提供旧版 SSE、stdio、OAuth 或模型 API 转发。覆盖预设默认超时 120 秒，客户端工具超时建议至少 180 秒，并大于你设置的网关超时。

建议给调用方的研究指令见 [docs/research-workflow.md](docs/research-workflow.md)：拆分问题 → 多角度搜索 → 读完集合分页 → 查看各版本原文 → 补搜缺口和反证 → 逐主张引用、说明冲突。不在网关内调用额外模型。

### Claude Code

可将以下服务配置合并到项目 `.mcp.json`。先为 Claude Code 进程设置环境变量 `SEARCH_ANYWHERE_TOKEN`，值是在控制台创建的搜索访问凭证。[官方 MCP 配置说明](https://code.claude.com/docs/en/mcp)

```json
{
  "mcpServers": {
    "search-anywhere": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer ${SEARCH_ANYWHERE_TOKEN}" }
    }
  }
}
```

### Codex

在 Codex 的 `config.toml` 中添加以下配置，并确保启动 Codex 的进程可以读取 `SEARCH_ANYWHERE_TOKEN` 环境变量。[官方 MCP 配置说明](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.search_anywhere]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "SEARCH_ANYWHERE_TOKEN"
tool_timeout_sec = 180
```

### Hermes、LobeChat、Kelivo、DeepSeek Harness

在各客户端提供的 MCP 设置中选择 Streamable HTTP，填写上述 URL 和 `Authorization: Bearer YOUR_SEARCH_KEY` 请求头，再启用上述四个工具。若当前版本没有 HTTP MCP 或自定义请求头入口，需要客户端适配器；不要将此凭证当作模型 API key 使用。

以上客户端尚未在用户的实际安装环境逐一联调；本版已使用官方 MCP SDK 客户端完成初始化、工具列表、搜索、正文和错误处理测试。Pi 专用扩展按约定留到后续，届时复用 `/v1/search` 与 `/v1/fetch`。

客户端的模型仍可连接 CPA；为了使用此网关，可在客户端工具配置或指令中指定通过 `search-anywhere` 搜索。原生联网开关是否可替换取决于客户端实现。

## 配置与数据

可复制 `.env.example` 为 `.env`，修改后重启。已有进程环境变量优先。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SA_HOST` | `127.0.0.1` | 监听地址 |
| `SA_PORT` | `8765` | 端口 |
| `SA_DATA_DIR` | `.data` | 相对项目目录或绝对数据目录 |
| `SA_ADMIN_TOKEN` | 自动生成 | 可选管理员口令，至少 16 字符 |
| `SA_ALLOWED_ORIGINS` | 空 | 允许访问 `/v1`、`/mcp` 的额外浏览器 Origin，逗号分隔；不开放管理接口 |
| `SA_TRUST_PROXY` | 空 | 本机可信 HTTPS 反向代理时设为 `loopback` |

其他设备中的 `127.0.0.1` 指向该设备自身。需要远程访问时，在本机前置 HTTPS 反向代理，将网关保留在 `127.0.0.1`；配置 `SA_TRUST_PROXY=loopback`，代理保留原始 Host 并设置 `X-Forwarded-Proto`。客户端连接公网 HTTPS 域名。若客户端运行在 Docker 中，也要使用容器可达的主机地址。此版本未替你修改客户端配置或部署公网服务。

持久化内容在数据目录中：

- `gateway.sqlite`：配置、密文 key、用量、调用日志、完整结果集合和来源文本；运行时还可能有 `-wal`、`-shm` 文件。
- `encryption.key`：解密上游 key 必需的本地密钥材料。
- `admin-token.txt`：未使用环境变量指定口令时生成的管理员凭证。

**停止服务后整体备份数据目录。** 数据库和 `encryption.key` 必须配套恢复；其中包含加密的 Keenable、AnySearch、Parallel 登录凭证与最新续期结果、Parallel OAuth 客户端 ID，以及 Exa 会话 Cookie，可以一同迁移到 VPS。源码仓库不包含这些本地数据，克隆代码后仍需单独恢复整套数据目录。缺少密钥材料会拒绝启动，不能恢复明文。加密不替代操作系统文件权限：应限制整个数据目录的读取权限。搜索访问凭证仅存哈希，无法恢复，可撤销后重建。

本版面向个人或小团队单进程部署；不要让多个进程共用同一数据库。迁移时先停止旧实例，再启动 VPS，避免两个实例同时使用同一登录会话续期。日志和结果集合持续保留，暂无自动清理或备份任务，会占用磁盘。网页证据与查询以明文保存在本地 SQLite，上游密钥及官网登录 token 加密；管理 API 与日志不返回这些凭证的明文。

## 开发与验收

```powershell
npm test
npm run build
```

需求矩阵见 [docs/acceptance.md](docs/acceptance.md) 与 [docs/coverage.md](docs/coverage.md)。自动化覆盖存储、五家协议、轮询、并行/超时、域名限制、缓存、证据保留、分页/权限、用量、HTTP 和真实 MCP SDK 客户端。

单个/批量用量查询与真实响应差异的补充验收见 [docs/usage-refresh.md](docs/usage-refresh.md)。

浏览器验收使用 Python Playwright。安装 `playwright` 和 Chromium 后，在一个终端运行隔离测试服务器：

```powershell
node --import tsx tests/browser-server.ts
```

在另一个终端运行 `python tests/browser_test.py`，完成后停止测试服务器。每次测试使用新的临时数据库；重复运行前重启测试服务器。截图和结果写入 `test-results/`。生产数据和真实 key 不参与测试。

自动化供应商测试使用模拟响应。另经用户授权完成 Tavily 用量、Keenable 余额及 AnySearch 请求额度的真实查询；两家网页登录续期均已实测成功，详见各接入记录。这些查询不等于五家真实搜索能力的完整验收。

协议参考：[Exa Search](https://exa.ai/docs/reference/search)、[Parallel OpenAPI](https://docs.parallel.ai/public-openapi.json)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
