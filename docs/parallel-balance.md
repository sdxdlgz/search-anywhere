# Parallel 余额接口与免费额度核查

核查日期：2026-09-14。余额 OAuth 配置与免费优先路由现已接入代码；真实账号授权仍由用户在本地表单发起并在官网确认，尚未声称用户账号余额实测成功。Exa 官网验证问题按用户要求暂时搁置。

## 官方余额接口已经存在

官方文档及 Account Service OpenAPI 均公开了以下只读调用：

```http
GET https://api.parallel.ai/account/service/v1/balance
Authorization: Bearer <Account API access_token>
```

需要由 Parallel 支持的 OAuth 流程签发的 **Account API access token**。文档明确排除普通搜索 API key，不能只改成 Bearer 就代替账号授权，也不能假定官网 Cookie 或其他产品的 access token 可直接使用。

| 字段 | 官方含义 | 网关接入时的处理 |
| --- | --- | --- |
| `org_id` | 组织 ID | 用于官方组织归属和共享余额去重，不能用账号来源备注代替 |
| `credit_balance_cents` | 预付余额，包含 credits 与 prepaid commits，单位美分 | 按金额展示；不是搜索次数，也不是累计赠送总额 |
| `pending_debit_balance_cents` | 正在执行任务占用的金额与尚未同步到账单服务的费用，单位美分 | 与余额单独保留，不能当作历史全部消费 |
| `will_invoice` | 是否按后付费账单结算 | 为 true 时以上两个金额按协议总是 0，不能据此判断账号没有可用额度 |

当前 BalanceResponse 没有赠送记录、注册奖励领取状态、每笔额度到期日或每月赠送资格字段。因此即使查询余额成功，也不能用这个接口单独解释“为什么只送了 20，而不是 80”。官方 schema 的金额类型是 number，接入时不能未经核验就限制为整数美分。

来源：[Get Balance](https://docs.parallel.ai/service-api/balance/get-balance)、[Account Service OpenAPI](https://api.parallel.ai/account/service/openapi.json)。

## 官方授权和续期路径

官方支持 Device Authorization Grant：注册客户端 → 请求设备码 → 用户在官网授权 → 轮询换取 access token / refresh token → 查询余额 → 到期刷新。适合未来部署到 VPS，无需在 VPS 中维持官网登录 Cookie。

| 动作 | 官方地址 |
| --- | --- |
| 注册客户端 | `POST https://platform.parallel.ai/getServiceKeys/register` |
| 请求设备码 | `POST https://platform.parallel.ai/getServiceKeys/device/code` |
| 获取／刷新 token | `POST https://platform.parallel.ai/getServiceKeys/token` |

刷新采用 `grant_type=refresh_token`，官方要求保留返回的新 token 对。余额属于组织；接入时需要核对组织与搜索凭证的关联、加密保存 token，并对同组织余额去重。仅凭用户给两个 key 写了相同备注，不足以证明它们共享余额。

网关只申请 `balance:read`，使用自己的注册客户端；不使用官方 CLI 默认包含的充值、创建/删除应用及 key 等权限，也不自动创建搜索 key。授权成功返回 `org_id`，查询余额必须返回同一个组织；OpenAPI 没有现有搜索 key 的组织反查接口，因此界面称“授权组织余额”，提示授权时选择这把 key 所属组织，不声称已自动证明 key 的归属。[官方 CLI scope 定义](https://github.com/parallel-web/parallel-web-tools/blob/main/parallel_web_tools/core/endpoints.py)

在密钥行的钥匙按钮中选择“开始官网授权”，网关返回官网链接与短授权码，设备凭证和 token 不返回浏览器。轮询遵循官方 interval / slow_down / Retry-After，拒绝、过期、取消、配置变化会中止相关流程；关闭弹窗取消待授权请求，原有授权保留到新授权成功。注册客户端 ID 保存在 SQLite，已完成授权按 key 加密保存，随 `.data` 与加密主密钥迁移；尚未完成的授权流程不跨进程保存，重启后重新开始即可。

Access token 到期前一分钟或首次 HTTP 401 后续期；返回的新 token 对先持久化，再查询余额，refresh token 未轮换时保留原值。并发续期合并、版本校验避免旧请求覆盖新凭证，授权/refresh 有效期结束后提示重新登录。单个、批量与定时查询共用这些逻辑，不增加搜索调用数；失败保留旧快照，后付费组织不按预付 0 判定没额度。移除仅删除本地余额授权，不改变搜索 key 或替用户撤销其他网页登录。[官方续期实现参考](https://github.com/parallel-web/parallel-web-tools/blob/main/parallel_web_tools/core/auth.py)

来源：[官方 Account API 授权说明](https://docs.parallel.ai/integrations/account-api)。

## 20 美元与“最高 80 美元”

用户报告新账号实际到账 20 美元；这是该账号观察到的金额，不应直接推广成所有账号固定赠送 20 美元。

当前价格页写的是注册最高 80 美元。核查了价格页、官方 FAQ、公开注册页和其引用的前端脚本，没有找到能确认“20 + 60”的奖励拆分或领取条件。匿名访问官网注册后引导 `/onboard` 和 `/post-auth-sign-up` 均跳转登录；当前连接浏览器没有可检查的 Parallel 登录页面。

因此目前不能断言剩余 60 美元需要绑卡、企业邮箱、邀请好友或完成任务，也不能保证一定可以补领。下一项有用证据是该账号控制台中额外奖励的条件文字或官方对这个账号的解释。已向用户询问奖励入口文字，不索取明文登录凭证。

价格页另列“符合条件的初创公司最高 250 美元”，这是另一项申请计划，不应混算到普通注册的 80 美元中。

来源：[官方价格页](https://parallel.ai/pricing)。

## 每月 5 美元确实有绑卡条件

2026-07-15 的官方公告明确要求符合条件的组织已绑定信用卡：

- 已绑卡且符合条件时，每月自动发放 5 美元。
- 未使用的这笔月度赠额在月底过期，不结转。
- 同一张卡仅能为一个组织启用月度赠额。
- Marketplace 和 postpaid 组织目前不符合资格。
- 超出额度的使用按正常价格计费；“每月 5 美元”不代表每月最多扣 5 美元。

“每月最多 5,000 次”是按便宜模式把同一笔 5 美元折算出的调用量，不是额外再加一份请求配额。不能将“注册不需要信用卡”理解为“月度赠额也不需要信用卡”。这份公告也没有保证绑卡会补齐注册奖励到 80 美元。

来源：[每月免费额度公告](https://parallel.ai/blog/free-tier-parallel)。

## 还有独立的免费 Search MCP

`https://search.parallel.ai/mcp` 支持匿名免费使用，不要求账号、API key 或信用卡，提供 `web_search` 与 `web_fetch`。

当前文档说明匿名请求默认使用 fast 模式，搜索配置由服务端管理；匿名请求上的自定义模式等覆盖参数会被忽略。工具返回的总摘录约限制为 25,000 字符。免费入口存在较低速率限制，当前官方页面没有给出可作为稳定承诺的固定每日／每月次数。

这是一条独立访问方式，不向用户账号余额里充值。经用户确认，Search Anywhere 普通 Parallel 预设默认先使用匿名 MCP，明确限流后才用 key 按配置模式补充；advanced 直接走 REST。每个预设可以改为始终使用 API，实际模式、入口、数量限制与回退原因会显示在响应和日志中。

来源：[Search MCP 文档](https://docs.parallel.ai/integrations/mcp/search-mcp)、[免费 MCP 公告](https://parallel.ai/blog/free-web-search-mcp)。

### 在本项目中的实际可用性

2026-09-14 使用项目已有的 `@modelcontextprotocol/sdk` 对官方 `/mcp` 做匿名实测，未读取或发送任何上游 key：初始化、工具列表、一次 `web_search` 和一次 `web_fetch` 均成功。搜索使用 SQLite 官方 WAL 文档这一公开问题；网页读取请求 `full_content: true`。两种工具均返回 `structuredContent`，也提供 `parallel/usage` 元数据。

搜索 JSON 文本块约 18,041 字符，网页读取 JSON 文本块约 35,434 字符；这些是整个 JSON 块长度，不是纯正文长度。25,000 字符的官方说明针对摘录，不能用它断言完整正文始终不超过该长度。只读 SDK 兼容性实测记录在 `test-results/parallel-research/mcp-probe.json`；它不代表固定免费调用次数或长期可用性保证。

网关免费入口不创建伪造 key，使用空 key_id 独立记录调用量、错误与限流，费用明确标为免费，剩余免费次数不做推算。429 触发当前进程共享冷却；到期重试免费，其他错误和空结果不触发额度回退。正文也遵循免费优先/advanced/API 策略，发起 `full_content: true`，通过现有证据分页读取；上游抓取能力、100,000 字符/4 MB 本地限制仍适用。

如果每次仍同时调用原有付费 Parallel，再追加免费 MCP，会增加资料来源，但不会减少原有 Parallel 调用费用。免费入口要实际节省费用，需要替代一部分原本收费的调用；这也意味着相关请求采用 fast 的能力范围。两个入口属于同一供应商，不应当作两家独立信息来源来计算交叉佐证。

免费与 API 是同一家 Parallel，不增加独立来源计数。读取正文只能补充已命中 URL，不能补回没有找到的页面；需要更完整的覆盖时仍应选择 advanced 并做多角度补搜。

后续使用已实现的网关在独立临时数据库中实测：免费 fast 搜索保留 7 个 SQLite 官方域名结果，`web_fetch(full_content=true)` 保留 31,637 字符原文，未触发本地截断，两次均标记免费。记录见 `test-results/parallel-research/gateway-free-probe.json`。这验证了本次适配器与正文分页链路，不代表每个网站都能返回完整正文或免费服务长期无变化。

## 实际核验与边界

- Account Service OpenAPI 实际下载 HTTP 200；核对了精确地址、BearerAuth 说明和 BalanceResponse 四个字段。
- 未授权请求正式余额接口实际返回 HTTP 401。没有用户的 Account API OAuth 凭证，未声称真实余额查询或续期成功。
- 官网公开脚本还可见 `/api/rpc/billing/payments/refresh-balance` 与 `/api/acc_svc/check-balance`，以及余额和待扣金额分开处理的逻辑。它们是官网内部入口，本次未带用户登录调用；既然已有公开接口，接入应优先采用公开协议。
- 公开页面、20 个引用脚本与 OpenAPI 存于 `test-results/parallel-research/`，`sources.json`、`script-index.json`、`onboard-sources.json` 保存精确来源与状态。没有真实 key、token、Cookie 或登录后账号响应。
- 网页工具打开 Get Balance 的 `.md` 地址返回不可重试的安全打开错误，改为正常文档 URL 和官方 OpenAPI 后验证成功。
- 最初调查只更新文档；后续实现了免费路由与余额 OAuth，验收场景记录于 [需求驱动验收](acceptance.md) 的 P1–P5 / B1–B4。账号授权未由测试替用户批准。本文引用的 `test-results/` 为本地验证产物，不提交仓库。
