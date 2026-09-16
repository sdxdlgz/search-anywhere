# 使用指南

[返回 README](../README.md) · [客户端接入](clients.md) · [部署与配置](deployment.md)

## 配置供应商

在 **供应商与密钥** 中选择渠道并添加 API key。每行一个 key，单批最多 50 个；只有要使用的供应商需要配置。

| 供应商 | 网关可配置的搜索模式 | 额度查询 |
| --- | --- | --- |
| Exa | `instant`、`fast`、`auto`、`deep-lite`、`deep`、`deep-reasoning` | 官网 Cookie / Team ID、管理 API 或手动余额估算 |
| Parallel | `turbo`、`fast`、`basic`、`advanced` | OAuth 授权后读取组织余额 |
| Tavily | `ultra-fast`、`fast`、`basic`、`advanced` | 搜索 key 查询官方用量 |
| AnySearch | `auto` | 官网 access/refresh token |
| Keenable | `realtime`、`pro` | 官网 access/refresh token |

表中为当前适配器支持的选项；实际可用模式、额度与返回数量由供应商及账号权限决定。官网额度查询所需凭证与搜索 API key 分开保存。

## 管理 key

同一供应商的可用 key 会参与轮询，网关按配置限制并发，并对失败进行隔离和有限重试。每个 key 可单独启停、编辑、测试或查询用量，批量用量查询单独触发。

`账号归属` 用于记录账号来源，便于识别和排查；相同备注的 key 分组排序，同名前缀的自动编号会继续递增。备注不用于证明多个 key 共享同一额度。

供应商密钥加密保存，界面只显示首尾片段。搜索访问凭证在 **客户端接入** 中创建，用于授权客户端调用网关，可分别删除。删除后凭证立即失效，并从列表及数据库中移除；历史调用记录和全局用量、费用仍保留。旧版本已撤销的凭证会在升级或导入旧备份时清除。

## 搜索预设

在 **搜索预设** 中统一配置供应商模式、每家请求数量、展示页大小、超时、缓存和正文读取策略。调用时通过 `profile` 指定预设；省略时使用控制台的默认预设。

新安装默认使用 `coverage`。升级保留已有预设和默认选择。

| 预设 | Exa | Parallel | Tavily | AnySearch | Keenable | 总超时 |
| --- | --- | --- | --- | --- | --- | --- |
| `coverage` | deep-reasoning | advanced | advanced | auto | pro | 120 秒 |
| `fast` | fast | fast | fast | 关闭 | 关闭 | 8 秒 |
| `balanced` | auto | basic | basic | 关闭 | 关闭 | 15 秒 |
| `thorough` | deep | advanced | advanced | 关闭 | 关闭 | 45 秒 |

以上为内置初始值，已保存的预设可以不同。`coverage` 默认关闭缓存，并在请求正文时并行调用支持的渠道；其他内置预设默认缓存 120 秒，正文按顺序回退。搜索不会自动读取每条结果的完整正文。

### Parallel 路由

普通检索和正文读取支持 `free_first`：先使用匿名免费 MCP，检索实际为其服务端提供的 `fast` 模式。只有明确的限流才允许回退到配置的付费 API，冷却期间复用该回退策略；无可用 key 时不会自动获得付费权限。

`advanced`、`api` 直连策略和指定 key 测试直接调用 API。其他错误、空结果和本地域名过滤不会自动触发付费回退。免费 MCP 路由可以在没有 Parallel API key 时使用。

每条调用记录保留实际传输方式、模式和回退原因。[Parallel 路由与额度说明](parallel-balance.md)

## 检索和读取证据

1. 通过控制台、MCP `search` 或 HTTP `POST /v1/search` 创建结果集合。
2. 使用返回的 `collection_id` 继续读取结果页，直到 `next_offset` 为 `null`。
3. 使用 `get_evidence` 读取同一 URL 的各来源摘录；需要正文时调用 `fetch`。
4. 针对资料空缺或冲突调整查询，再继续检索。

`max_results` 是响应展示页大小，`per_provider_results` 是每家供应商请求量。网关保留本次调用实际返回的资料，不会因首页条数少而丢弃其余结果；供应商仍可能限制请求量或截断正文，并在查询提示中说明。

URL 规范化后合并重复结果，来自不同供应商的摘录分别保留。多家命中同一网页不构成多份独立佐证；网关不自动判定事实真伪。[研究工作流](research-workflow.md) · [上游查询提示](search-warnings.md)

## 用量和余额

控制台分别展示本地调用、上游报告用量、估算费用与官方额度快照。官方快照可能延迟更新，不会覆盖本地已记录的调用。未报告金额保持未知，不能当作免费；不同供应商的 credits 不能直接相加，也不能统一按 1:1 换算美元。

渠道额度按已验证的账号或组织去重汇总。同一来源备注下的独立账号分别计入；停用 key、失效登录和查询失败不会把历史额度改成零。今日、月度计量按 UTC 划分，时间按浏览器时区展示。

余额查询不等于搜索 key 测试。搜索、key 测试和正文读取会产生真实上游调用；费用以供应商最终账单为准。网关记录只覆盖经本网关发生的消费，Exa 手动估算不包含外部消费、赠送、到期及其他账务调整。

| 详细文档 | 内容 |
| --- | --- |
| [用量刷新](usage-refresh.md) | 单 key / 批量查询、官方快照和本地记录 |
| [Parallel](parallel-balance.md) | OAuth、组织余额与免费 MCP |
| [Keenable](keenable-balance.md) | 组织校验、官网登录与续期 |
| [AnySearch](anysearch-balance.md) | 账号匹配、网页登录与续期 |
| [Exa](exa-balance.md) | 官方查询、浏览器验证和手动估算 |
