# AnySearch 官网额度与登录续期

AnySearch 有官网额度接口，普通搜索 API key 无权访问。网关现在支持给每条 AnySearch key 配置官网登录凭证，查询账号请求额度并自动续期。单位是请求次数，不是 credits 或现金余额。

## 配置

登录 [AnySearch 官网](https://www.anysearch.com/console/overview)，按 F12 → Application → Local Storage → `https://www.anysearch.com`，找到 `search-template-auth-state`，展开 `state`，读取 `accessToken` 和 `refreshToken`。在网关密钥列表点击该 key 的钥匙图标，填写 refresh token；access token 可以留空，由网关续期获取。

输入框采用密码样式，保存后不回填。已配置时留空保留原凭证；“移除登录凭证”清除本地网页登录信息与额度快照，搜索 key 保留。来源备注只用于辨认，不决定登录身份或额度归属。

建议使用独立的官网浏览器会话，取出凭证后关闭官网页，避免浏览器和网关同时轮换同一 refresh token。官网退出登录可能撤销会话；迁移 VPS 前停止旧网关，避免两个实例同时续期。

## 已确认的官网协议

所有路径以 `https://www.anysearch.com` 为起点，拒绝重定向。它们来自官方控制台前端，是未作为公开搜索 API 承诺稳定性的接口。

| 方法与路径 | 鉴权／请求 | 用途 |
| --- | --- | --- |
| `POST /api/auth/refresh` | JSON `refresh_token` | 返回 `access_token`、轮换后的 `refresh_token`、`expires_in_seconds` |
| `GET /api/auth/me` | Bearer 官网 access token | 确认 `logged_in` 与账号标识 |
| `GET /api/user/keys` | 同上 | 在内存中比对完整搜索 key，防止绑定其他账号的额度 |
| `GET /api/user/billing/overview` | 同上 | 读取请求总额度、已用、剩余、套餐、重置周期与可用的历史调用数 |

响应成功码为 `code: 0` 或 `200`，内容在 `data`。HTTP 401 或业务码 40101／40141 视为登录失效；不会把业务错误当作空额度。AnySearch 使用自身认证服务，不能套用 Keenable 的 Supabase 刷新地址。

账号 `total`、`used`、`remaining` 分开保存，剩余采用官方返回值，不通过相减推算；`reset_period` 与 `next_reset_at` 保留。key 的 `quota_used` 与 `quota_limit` 单独显示，无限额不显示成零。历史调用数缺失时保持未知。

核验后的账号标识仅保存哈希，用于渠道内共享额度去重；同一账号多条 key 使用最新快照累计一次。完整官网 key 列表、原始账号身份与登录 token 不进入管理响应或日志。

## 续期与兼容

access token 距到期不足 60 秒时先续期；尚未到期但接口拒绝登录时最多刷新并重试一次。两枚新 token 立即加密持久化，即使之后查询失败也保留续期结果。同一 key 的并发查询合并，配置替换／移除期间的旧响应无法覆盖新凭证。

refresh token 被拒绝时标记需重新登录，暂停自动查询，保留旧快照与搜索 key 状态。网络、限流或服务端临时错误不删除登录信息。单条查询、所选批量与后台同步复用此流程；本地页面刷新不发上游额度请求，也不增加搜索调用数。

使用新增的 `anysearch_sessions` 表和既有加密材料；旧 `keenable_sessions` 表及接口保持兼容。停止服务后整体复制数据目录，配套恢复 `gateway.sqlite` 与 `encryption.key`，即可迁移两家的最新加密凭证。

## 核验记录

2026-09-14：精确的官网额度路径在匿名和搜索 API key 鉴权下均返回 HTTP 401／业务码 40141。经用户授权，官网登录凭证访问身份、密钥列表与额度接口均返回 HTTP 200／code 0，并精确匹配已导入的搜索 key。实测账号返回 Free Plan、每日总额度 1,000 次、已用 0、剩余 1,000，下次重置时间为 `2026-09-15T00:00:00Z`。这些数值是该账号当时的快照，不代表所有套餐的承诺。

实际 refresh 请求返回 HTTP 200、`expires_in_seconds: 1800`，refresh token 已轮换；新凭证立即加密保存。全过程未调用搜索接口。

自动化需求 A1–A4 覆盖加密、旧数据兼容、目录迁移、过期与错误响应、并发替换、账号错配、准确单位、去重、单个／批量／后台查询和密码表单。测试使用专用假凭证。

最终验收：73 项自动化测试、生产构建及完整桌面／移动端浏览器回归通过。已运行的新网关通过“只配置 refresh token”实际续期，保存轮换后的凭证并查询官方额度，HTTP 200；全部 16 条搜索 key 和 3 份原有 Keenable 登录记录保持原样，搜索调用数未增加。临时加密凭证文件在绑定成功后移除，最新凭证保存在数据库中。

来源：[官方额度前端](https://www.anysearch.com/_next/static/chunks/0mllr4qsq7t_e.js)、[官方密钥列表前端](https://www.anysearch.com/_next/static/chunks/0fm3pd._z8kt5.js)、[官方认证与本地存储实现](https://www.anysearch.com/_next/static/chunks/025_ovj6ns_gh.js)、[公开搜索文档](https://www.anysearch.com/docs)。构建文件地址可能随官网发布变更；公开源码副本位于本地 `test-results/anysearch-research/`。
