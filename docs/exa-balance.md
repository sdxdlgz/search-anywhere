# Exa 官网余额与 Cookie 配置

Exa 官网余额查询与 Team Management 月消费查询是两套入口。网关支持为每条 Exa key 配置会话 Cookie 和 Team ID，查询团队美元余额；也支持手动校准余额后按网关调用估算扣减。官网模式下未配置 Cookie 时，原有 Service Key 用量接口继续工作。

## 网站验证与查询暂停

2026-09-14 从本机对 `/api/auth/session` 做一次匿名只读复测，收到 HTTP 429、`Content-Type: text/html`、`Server: Vercel`、`x-vercel-mitigated: challenge`，正文为 Vercel Security Checkpoint，且没有 `cf-mitigated`。本次响应是网站浏览器验证，不能将它解释为搜索 key 超额或用户违规，也不能认定是 Cloudflare。

网关优先识别明确的 Vercel / Cloudflare challenge 响应头，暂停此登录配置的后台余额查询并保留旧快照、Cookie 和搜索状态；页面显示可展开的简短说明。单独查询可以再次尝试，成功后恢复自动同步；更换会话凭证会使旧暂停记录失效。普通 429 按 `Retry-After` 冷却，缺省 60 秒，范围 1 秒至 1 小时，冷却期间单独点击也不重复请求。HTTP 403 权限错误和登录失效仍分别处理，不把普通 HTML 或错误正文猜测成验证页。

部署后使用一个本地已配置 Exa 会话进行实际查询，也识别到 Vercel challenge；管理接口明确返回浏览器验证状态，后台暂停标记已保存，旧余额快照与搜索状态不变。此实测验证了错误分类和保护逻辑，未声称已通过验证或成功取得官方余额。

浏览器里打开官网成功，并不保证服务器 HTTP 请求也能通过网站验证。网关不运行验证页脚本，也不承诺复制浏览器的过盾 Cookie 后能长期使用；可以直接采用下面的手动方式。[Cloudflare 官方响应识别说明](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)

## 手动校准和本地估算

1. 在 Exa key 的钥匙按钮中，将“余额方式”改为“手动余额 · 本地估算”。
2. 输入此刻官网显示的 USD 余额，点击“保存并校准余额”。支持 0、负数和最多 6 位小数；不会默认填入历史余额或赠送额度。
3. 同团队多把 key 可以填写相同的共享 Team ID，共用一份余额；留空只统计这把 key。这是使用者指定的归属，不等于官网验证。相同来源备注不会合并余额。

每次校准以当前调用游标为起点，用整数微美元保存金额。之后实际经过网关的 Exa 搜索、正文读取、指定 key 测试和重试按各自日志扣费；缓存命中和其他供应商不扣这份余额。存在尚未结束的关联调用时，校准返回 409，避免把尚未计清的调用重复纳入新余额。再次校准替换起点，不重复扣之前的调用；同团队的官方旧快照与手动余额不会相加。调用归属在开始时固化，删除 key 或改来源备注不删除已记费用。

费用优先采用响应中的 `costDollars.total`，有效的 0 也保留；缺失时按下表及上游实际返回条数估算，计算发生在本地 URL 过滤之前。当前适配器搜索只请求 highlights，正文提取只请求 text。日志区分上游报告与本地估算。

| 操作 | 内置标准价格（2026-09-14 核对） |
| --- | --- |
| instant / fast / auto 搜索 | 每次 $0.007，含前 10 条 |
| deep-lite / deep 搜索 | 每次 $0.012，含前 10 条 |
| deep-reasoning 搜索 | 每次 $0.015，含前 10 条 |
| 超过 10 条的返回结果 | 每条另加 $0.001 |
| 当前 text 正文提取 | 每页 $0.001 |

Exa 文档将 `costDollars` 也定义为费用估计，实际账单按使用计数结算。因此整个结果始终标为**本地估算**，不是官方剩余余额。请求失败或仍在进行而未取得费用时，单列“费用未知”数量，不能假定免费。外部消费、折扣、充值、月度赠额和额度到期不自动推算，发生这些变化时需重新校准；负余额不自动停用搜索 key。[官方价格](https://exa.ai/pricing)、[Search 费用字段说明](https://exa.ai/docs/reference/search)

手动模式下，行内和批量查询只重算本地账目，不调用官网；后台查询跳过该 key。切回官网模式保留原有 Cookie 和官方快照，随后查询失败也不会将估算覆盖成“官方数据”。基线、模式、团队归属和暂停记录均存于 SQLite，与整个数据目录一起迁移。

## 本地配置

在密钥列表点击 Exa key 的钥匙图标，填写 Team ID 和会话 Cookie。用户当前浏览器确认的名称是 `next-auth.session-token`，可直接粘贴其完整会话值，也支持 `next-auth.session-token=对应的值`。单独粘贴完整的五段加密会话值时，网关自动补上这个 Cookie 名称。没有 `__Secure-` 前缀是正常的。

也支持 `__Secure-next-auth.session-token`，这种情况请保留名称；如果有 `.0`、`.1` 等分片，按“名称=值; 名称=值”输入全部连续分片。两种名称不能混用。网关仅保留会话 Cookie，统计、广告、支付及其他 Cookie 不会保存或转发。Cookie 采用密码输入框，加密后不返回明文；已配置时留空保留，更换 Team ID 时必须重新填写 Cookie。

查询先读取官网会话的当前团队，再用搜索 key 调用官方 `/v0/teams/me`，两者与填写的 Team ID 一致才读取余额。网关不会替你切换官网团队。如果团队核对接口拒绝访问，会显示核对失败，不会猜测归属或填入其他团队的余额。

官网模式下，单条、所选批量与后台查询均使用相同流程。过期 Cookie、团队错配或浏览器验证会暂停该登录配置的自动查询，保留已有快照与搜索状态；更新配置后可重试。网络、429 或服务端错误不会把余额记成零。

官网返回新的会话 `Set-Cookie` 时，网关会在后续请求前立即加密保存，支持分片替换和删除；这不等于已验证长期自动续期。Exa 未提供可照搬的 access/refresh token 对，登录失效时仍可能需要重新复制 Cookie。其有效期来自官网 session 响应。

“移除登录凭证”只清除本地 Cookie 和余额快照；搜索 key 与原有 Service Key 均保留，之后可以继续查询管理接口的本月已用费用。停止服务后配套备份数据库和 `encryption.key`，即可将最新加密 Cookie 一同迁移到 VPS。

## 已确认的前端调用

| 方法与地址 | 前端用途 |
| --- | --- |
| `GET https://dashboard.exa.ai/api/get-credits` | 返回余额相关字段：`orbCreditsInCents`、`orbInvoiceDebt`、`expiringCredits` |
| `GET https://dashboard.exa.ai/api/orb/get-orb-plan` | 读取套餐，前端根据 `subscription.plan.external_plan_id` 区分显示逻辑 |
| `GET https://dashboard.exa.ai/api/team-context` | 官网前端使用的团队与角色信息；网关不调用 |
| `GET https://dashboard.exa.ai/api/auth/session` | NextAuth 会话；当前团队来自 `session.user.currentTeamId` |
| `GET https://api.exa.ai/v0/teams/me` | 使用搜索 key 独立核对所属团队，不发送官网登录 Cookie |

余额页直接请求 `/api/get-credits`，没有在该调用中传搜索 key、Service Key 或 teamId 查询参数。客户端采用同源请求，依赖官网登录会话。公开前端含两种会话 Cookie 名称，用户进一步确认其浏览器使用不带前缀的单条名称。

官网团队切换调用 NextAuth 的 `update({currentTeamId})` 更新会话；网关只做团队核对，不调用切换接口。渠道汇总按验证后的团队哈希去重，同一团队多条 key 的余额只累计一次，来源备注不参与计算。

## 金额与角色

`displayedBalanceCents` 前端函数的规则为：普通套餐显示 `orbCreditsInCents - (orbInvoiceDebt ?? 0)`；`search_api_enterprise` 与 `search_websets` 显示 `max(orbCreditsInCents, 0)`。最终金额按美分转换美元；缺少 credits 时返回未知。到期额度单独保留 `balanceCents` 和 `expiresAt`，不能当成每日／每月请求次数。

前端以 `credits_read` 检查余额页访问。当前角色定义中 MANAGER、OWNER 包含该权限，MEMBER、VIEWER 不包含。这是官网团队角色权限，与开通 Team Management Service API Key 不同；后端的实际权限结果还需登录验证。

## 验证与边界

2026-09-14 用户在已登录浏览器直接访问余额接口成功，提供了真实响应：`orbCreditsInCents=2000`、`orbInvoiceDebt=0`，以及 `balanceCents=1000` 在 `2026-10-01T07:00:00+00:00` 到期。即当前余额 20 美元，其中 10 美元在北京时间 2026-10-01 15:00 到期。到期部分已经包含在 20 美元中，不能再加一次；另一部分的到期时间未由该响应说明。

这证明用户浏览器的余额路径有效；用户随后报告直接粘贴会话值被拒绝，网关已兼容这种输入格式。格式校验通过不等于官网登录有效；服务器端完整的团队核验、套餐查询及 Cookie 更新仍需通过本地表单实测。生产环境可能受到供应商的 429／风控限制，错误会如实显示。

- 普通 HTTP 抓取主页／Billing 返回 429。独立 Chromium 可加载 Billing 公共脚本，未登录后跳转到 `auth.exa.ai`。
- 捕获了官方脚本和精确来源，见 `test-results/exa-research/script-index.json`。首次等待 `networkidle` 超时，但脚本已加载；改用 `domcontentloaded` 后正常完成。浏览器调试运行时因本机 Codex 配置解析失败而不可用，未修改该配置。
- 初始匿名直连余额、套餐、会话三条路径均返回 429；这不能证明搜索 key 被拒绝。
- 全程未进行充值、订阅迁移、团队切换或账单修改。自动化验收使用假 Cookie 和隔离数据；真实 Cookie 应在本地配置表单填写。
- 验收矩阵 E1–E5 覆盖 Cookie 输入边界／更新、加密与迁移、团队错配、套餐金额、到期部分、失败恢复、并发替换／移除、旧管理接口兼容、单条／批量／后台查询、美元汇总与桌面／手机表单。
- E6 补充直接粘贴完整会话值、保留原有名称写法、拒绝不完整值／超长值，以及错误替换不覆盖已保存凭证。最终 85 项回归测试、生产构建和完整浏览器验收均通过；已更新本地服务，17 把搜索 key 与已有两家登录凭证保持不变，未新增搜索调用。真实 Exa 登录仍待在本地表单保存并查询。

## 原始来源

- [余额查询、套餐查询和金额计算](https://dashboard.exa.ai/_next/static/chunks/0w9ec14q0~s0c.js)
- [团队会话与角色权限](https://dashboard.exa.ai/_next/static/chunks/0of8fpnyr3ehw.js)
- [余额访问权限检查](https://dashboard.exa.ai/_next/static/chunks/0mv41~fvgjn3n.js)
- [官网 Cookie 名称](https://dashboard.exa.ai/_next/static/chunks/07r~m-r7c9fsk.js)
- [Exa 官方 Billing 文档](https://exa.ai/docs/reference/billing)
- [公开 Team Management 消费用量接口](https://exa.ai/docs/reference/team-management/get-api-key-usage)

这些控制台路径未作为公开搜索 API 承诺稳定性；构建脚本 URL 也会随官网发布变化。
