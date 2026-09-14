# Keenable 余额接口核验（2026-09-14）

结论：存在官网控制台使用的余额接口，需要网页登录会话，不能直接使用搜索 key。现已接入加密会话保存、自动续期和官方余额查询；原有单行、所选批量、定时同步均可使用。

## 找到的接口与字段

- `GET https://api.keenable.ai/bff/organization/balance`。
- 官网组织 API 客户端从 `auth.getSession()` 取 `access_token`，发送 `Authorization: Bearer <登录会话 token>`。没有该 token 时客户端直接报无认证信息。
- 控制台用 `free_credits` 表示免费额度，优先读取 `charged_spendings`，缺失时回退到 `search_spendings + fetch_spendings + workflow_spendings`；免费剩余按免费额度减去已计费消耗计算，下限为 0。页面还读取 `paid_credits` 和 `activation_date`。
- 已实测用户授权的网页登录 access token 查询返回 HTTP 200；过期后使用 refresh token 续期也返回 200，并返回新的 access token / refresh token。初次查询的免费额度为 100,000 credits，实际显示始终以最新响应为准，不将此数写成默认套餐额度。

## 配置与自动续期

- 在密钥页点击 Keenable 行的钥匙图标，填写 Refresh token；Access token 可选，省略时首次查询自动续期。两项均为密码输入，保存后不回填明文。已配置时全部留空保留原值，移除只删除官网登录凭证与对应快照，不删除搜索 key。
- 获取位置：官网登录后 F12 → Application → Local Storage → app.keenable.ai → sb-…-auth-token。建议使用独立网页登录会话，取出后关闭官网页；不要让浏览器与网关并行续期同一个会话，官网退出登录也可能撤销会话。
- 固定续期地址：`POST https://caqmfcgrdovyjdhfnwzw.supabase.co/auth/v1/token?grant_type=refresh_token`，请求头 `apikey` 使用官方前端公开的 anon key，请求 JSON 为 `{ "refresh_token": "<登录续期凭证>" }`。公开项目配置写在适配器中，真实账号 token 只在加密数据存储中。
- 查询前检查到期时间，提前一分钟续期；余额 HTTP 401 最多触发一次续期与一次重试。新 token 对必须先原子加密保存，再进行余额请求，避免余额失败导致新 refresh token 丢失。同 key 的并发查询合并，删除或更换凭证后拒绝旧请求回写。
- 续期 400/401/403 视为需要重新登录，停止定时重试；网络、限流或服务错误保留凭证与旧快照。所有失败只影响余额查询，不将搜索 key 标为失效，也不增加搜索调用计数。
- 每次读取用搜索 key 调用 `/v1/auth/user`，将返回 org_id 与余额 org_id 比对，不一致不采纳额度。快照仅保存组织标识的哈希，用于渠道内共享额度去重，不保存邮箱、用户 ID 或原始组织 ID。
- 免费额度和付费余额分开存储，不假设付费总额、已付费消耗或额度与次数的固定换算。缺失或非法字段报错，保持上次快照。
- 管理接口：`PUT /api/keys/:id/keenable-session` 保存、`DELETE` 移除，都需要现有管理登录；余额仍调用 `POST /api/keys/:id/usage`。新 SQLite 表自动创建，旧安装无手工迁移；停止服务后复制整个数据目录及 encryption.key 可在 VPS 恢复最新 token 对。

此能力依赖官网 BFF 与当前 Supabase 项目配置，官网改版可能需要更新适配器。项目仍只支持单进程；迁移后不能同时运行旧实例继续续期。

## 只读实测

使用已导入的一把 Keenable 搜索 key，仅在进程内解密并发送给 `api.keenable.ai`；没有执行搜索，没有打印 key、邮箱、用户 ID 或组织 ID。

| 请求 | 认证 | 结果 |
| --- | --- | --- |
| `/v1/auth/user` | `X-API-Key` | HTTP 200；返回身份与组织元数据，没有额度字段 |
| `/bff/organization/balance` | `X-API-Key` | HTTP 401 |
| `/bff/organization/balance` | `Authorization: Bearer <搜索 key>` | HTTP 401 |
| `/bff/organization/balance` | `Authorization: Bearer <网页登录 access token>` | HTTP 200；返回官方余额字段 |
| Supabase `/auth/v1/token?grant_type=refresh_token` | 官网公开 anon key + 用户授权 refresh token | HTTP 200；返回并加密保存轮换后的 token 对 |
| 网关 `/api/keys/:id/usage`（部署后实测） | 本地管理会话；由适配器自动续期上游 token | HTTP 200；组织校验通过，新 token 对已入库，免费剩余 100,000 credits，付费余额 0 |

官方 CLI 的 `/v1/auth/user` 调用确认该 key 在搜索 API 认证路径上有效；余额接口拒绝搜索 key 不能解释为 key 本身失效。授权测试只查询身份、余额与续期，不执行搜索；返回 token 未打印或写入明文文件。

## 官方来源

- [控制台](https://app.keenable.ai/)
- [组织 API 客户端](https://app.keenable.ai/assets/orgInfo-DrODXTGC.js)：余额路径和会话认证。
- [额度计算](https://app.keenable.ai/assets/consoleQueries-DxNtD4Zx.js)：免费额度、已扣消耗和重置时间。
- [账单页](https://app.keenable.ai/assets/billing-Cq-DZgSU.js)：读取免费及付费额度。
- [官方 CLI 认证检查](https://github.com/keenableai/keenable-cli/blob/main/src/api.rs)。
- [公开 OpenAPI](https://docs.keenable.ai/api-reference/openapi.json)：当前列出搜索、抓取及各自的无 key 路径，没有余额路径。
- [Supabase 会话与 refresh token 轮换规则](https://supabase.com/docs/guides/auth/sessions)。

这些带构建哈希的脚本 URL 可能随控制台升级变化。核验时的公开源码保存在 `test-results/keenable-research/`；此目录不包含用户登录凭证或真实余额响应。
