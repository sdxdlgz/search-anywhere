# 需求驱动验收

| ID | 需求 | 正常、边界、错误及状态转换 | 验证位置 |
| --- | --- | --- | --- |
| R1 | key 管理与账号归属 | 创建/批量、改备注与账号、禁用/恢复、删除；重复/短 key 拒绝；接口及数据库无明文 | storage.test.ts / api.test.ts / browser |
| R2 | 多 key 轮询 | 同供应商公平轮询、供应商隔离、禁用/冷却跳过、并发占用、恢复后参与；失败有限切换 | storage.test.ts / engine.test.ts |
| R3 | 模式集中管理 | 三预设、各供应商独立模式、保存后新请求生效、无供应商及非法模式拒绝 | api.test.ts / engine.test.ts / browser |
| R4 | 并行聚合 | 正常三源、重复 URL、排名融合、来源保留、结果数上限、空结果与全部失败区别 | engine.test.ts |
| R5 | 超时和费用 | 一源超时部分成功、全部失败、401/402/429/5xx 分类、每次尝试计数、失败不伪报零费用、每日调用上限 | engine.test.ts / providers.test.ts |
| R6 | 用量/官方额度 | 本地请求与上游调用分开；Tavily key/account 不重算，各家账号授权与官方快照分开处理，Parallel 按组织查询 USD 余额；同步失败保留旧数据并节流 | providers.test.ts / usage.test.ts / 各家 balance、session-api 测试 |
| R7 | 缓存 | 相同请求命中、并发合并、不跨客户端、模式/凭证变更失效、过期、部分失败不缓存 | engine.test.ts |
| R8 | HTTP/鉴权 | 管理登录/退出/错误口令、客户端 token 创建/删除、权限分离、输入校验、无异常信息泄露 | api.test.ts |
| R9 | MCP | 官方 SDK 客户端初始化/list/search/fetch；鉴权拒绝、工具失败返回错误、断开不泄露 | mcp.test.ts |
| R10 | 正文读取 | 三服务字段映射、来源 URL、公网 URL 校验、失败回退、字数上限 | providers.test.ts / engine.test.ts |
| R11 | 持久化 | 重启后 key/profile/log 保留；加密密钥不可用时明确失败 | storage.test.ts |
| R12 | 管理界面 | 登录、无数据状态、增改 key归属、脱敏、预设保存、统计/日志、测试查询、token 创建/删除；窄屏与无控制台错误 | browser + screenshot |

不使用真实上游 key；付费搜索与真实账户余额在用户录入凭证后通过测试页验证。

## Parallel 免费路由与余额授权

| ID | 验收要求 | 验证位置 |
| --- | --- | --- |
| P1 | 匿名 MCP 不发送 key；保留实际 fast 模式、上游结果数与本地过滤限制 | parallel-mcp.test.ts / parallel-routing.test.ts |
| P2 | 仅明确限流触发 API 补充；共享冷却、轮询、调用预算与取消；其他失败不自动消费额度 | parallel-routing.test.ts |
| P3 | advanced、API-only 与指定 key 测试直接使用 API；免费和收费尝试独立记录真实入口与模式 | parallel-routing.test.ts / parallel-api.test.ts / browser |
| P4 | 正文可超过 25,000 字符，持久化并分页；保留上游及本地上限 | parallel-mcp.test.ts / parallel-routing.test.ts / parallel-api.test.ts / browser |
| P5 | 旧预设缺省免费优先且不重写原配置；HTTP/MCP、日志、表单保存、移动端兼容 | parallel-api.test.ts / browser |
| B1 | 仅管理员发起 balance:read 设备授权；可信官网地址、轮询间隔、拒绝、过期、取消与并发保护；不返回设备凭证或 token | parallel-auth.test.ts / parallel-session-api.test.ts |
| B2 | 加密持久化和自动续期；先保存轮换 token，再查余额；拒绝旧请求覆盖新配置，失败保留旧快照和搜索状态 | parallel-balance.test.ts / parallel-auth.test.ts |
| B3 | 余额组织与授权组织一致；保留小数美分、负余额、待扣和后付费含义，按组织去重；不声称自动识别现有搜索 key 归属 | parallel-balance.test.ts / parallel-session-api.test.ts |
| B4 | 单条、批量、后台同步共用实现；官网授权、失败恢复、保存、移除与移动端可操作 | parallel-balance.test.ts / parallel-session-api.test.ts / browser |

2026-09-14：107 项后端回归测试、生产构建与完整 Chromium 浏览器流程通过。另在独立临时数据库中实测匿名免费搜索和正文读取：返回 7 个官方域名结果、保留 31,637 字符正文。真实 Parallel 账号余额仍需使用者在官网授权后验证；模拟 OAuth 测试不代表用户账号已授权。测试截图和实测产物保存在本地 `test-results/`，不提交仓库。

## Exa 余额后备与网站验证

| ID | 验收要求 | 验证位置 |
| --- | --- | --- |
| E7 | Vercel/Cloudflare 明确验证标记与普通 429、403、过期分开；持久暂停自动查询，尊重 Retry-After，显式重试恢复，旧余额/搜索状态/凭证保留 | exa-challenge.test.ts / exa-balance.test.ts / browser |
| E8 | 手动校准 0/负数/六位小数；校准游标、在途拒绝、重新校准、模式切换和旧请求保护；迁移及凭证不变 | exa-ledger.test.ts / exa-manual-api.test.ts / exa-challenge.test.ts |
| E9 | 后续搜索/正文/测试扣费，上游报告优先含 0，缺失按模式和原始结果数估算；缓存及其他供应商不扣，费用未知单列 | exa-ledger.test.ts |
| E10 | 明确 Team ID 共用基线，跨 key 费用、删除及改备注保留，官方/估算同团队不重复累计，不冒称已验证归属 | exa-ledger.test.ts / exa-manual-api.test.ts |
| E11 | 管理权限/输入校验、简短可展开验证提示、行/渠道区分估算、手动/官方/错误恢复、校准/负余额与移动端操作 | exa-manual-api.test.ts / exa_manual_browser_checks.py |

2026-09-14：最终 116 项完整回归、生产构建和完整 Chromium 流程通过，包含校准不使搜索缓存失效、表单校验无控制台异常和手机布局。本地部署后，实际已配置 Exa 会话查询正确识别 Vercel 验证并暂停后台重试，原有快照与搜索状态保留；没有执行真实付费搜索或自动填写余额。

## 初版验收结果

2026-09-12：26 项完整自动化测试通过；最后的 Exa 批量 ID 保护变更再次通过 3 项 API 测试。生产构建通过。桌面与移动端 Chromium 操作流程、截图检查通过，无非预期浏览器错误。实际生产进程的健康检查与页面资源通过。

真实供应商账户、用户安装的各客户端、公网代理部署尚未现场联调；不将模拟协议测试等同于这些环境的验证。
