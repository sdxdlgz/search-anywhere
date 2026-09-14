# Exa 官网余额与 Cookie 配置

Exa 官网余额查询与 Team Management 月消费查询是两套入口。网关支持为每条 Exa key 配置会话 Cookie 和 Team ID，查询团队美元余额；未配置 Cookie 时，原有 Service Key 用量接口继续工作。

## 本地配置

在密钥列表点击 Exa key 的钥匙图标，填写 Team ID 和会话 Cookie。用户当前浏览器确认的名称是 `next-auth.session-token`，可直接粘贴其完整会话值，也支持 `next-auth.session-token=对应的值`。单独粘贴完整的五段加密会话值时，网关自动补上这个 Cookie 名称。没有 `__Secure-` 前缀是正常的。

也支持 `__Secure-next-auth.session-token`，这种情况请保留名称；如果有 `.0`、`.1` 等分片，按“名称=值; 名称=值”输入全部连续分片。两种名称不能混用。网关仅保留会话 Cookie，统计、广告、支付及其他 Cookie 不会保存或转发。Cookie 采用密码输入框，加密后不返回明文；已配置时留空保留，更换 Team ID 时必须重新填写 Cookie。

查询先读取官网会话的当前团队，再用搜索 key 调用官方 `/v0/teams/me`，两者与填写的 Team ID 一致才读取余额。网关不会替你切换官网团队。如果团队核对接口拒绝访问，会显示核对失败，不会猜测归属或填入其他团队的余额。

单条、所选批量与后台查询均使用相同流程。过期 Cookie 或团队错配会暂停该登录配置的自动查询，保留已有快照与搜索状态；更新配置后可重试。网络、429 或服务端错误不会把余额记成零。

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
