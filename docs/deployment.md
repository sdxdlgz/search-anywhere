# 部署与配置

[返回 README](../README.md) · [使用指南](usage.md) · [备份与迁移](backup-migration.md)

## Docker Compose

需要 Docker Engine 和 Compose 插件，建议至少 2 GiB 内存，并为搜索历史预留磁盘空间。

```bash
mkdir -p search-anywhere
cd search-anywhere
curl -fsSLO https://raw.githubusercontent.com/sdxdlgz/search-anywhere/main/compose.yaml
docker compose up -d
docker compose exec search-anywhere npm run admin:token
```

服务默认监听部署主机的 `127.0.0.1:8765`。在该主机打开 <http://localhost:8765>，使用最后一条命令显示的管理员口令登录。服务日志只显示口令文件位置。

默认镜像 `ghcr.io/sdxdlgz/search-anywhere:latest` 支持 `linux/amd64` 和 `linux/arm64`，无需注册表登录。应用以非 root 用户运行，根文件系统只读；数据位于挂载到 `/app/data` 的命名卷 `search-anywhere_data`。

### 访问远程主机

首次配置可在本地计算机建立 SSH 隧道：

```bash
ssh -N -L 18765:127.0.0.1:8765 user@server
```

保持隧道连接，打开 <http://localhost:18765>。此地址只对建立隧道的计算机有效。持续对外提供 HTTP API 或 MCP 时，应使用客户端可访问的 HTTPS 域名。

### HTTPS 反向代理

将域名解析到服务器，使用 Nginx、Caddy 或已有反向代理提供 HTTPS。Compose 的发布端口保持绑定 `127.0.0.1`。

前方只有一个可信代理时，在 Compose 文件同目录的 `.env` 中设置：

```dotenv
SA_TRUST_PROXY=1
```

代理必须覆盖转发请求头。多层代理部署应使用实际可信代理的 IP/CIDR 配置，避免直接扩大信任范围。

在已配置证书的 Nginx `server` 块中加入：

```nginx
client_max_body_size 65m;
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 210s;
}
```

执行 `docker compose up -d` 应用环境配置。65 MiB 的上传限制用于容纳加密备份及元信息，210 秒读取超时为较长的搜索调用留出余量。

### 更新和回退

更新前在控制台导出备份：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

更新会保留命名卷。**`docker compose down -v` 会删除数据卷，不应作为常规更新命令。**

需要固定镜像时，在 `.env` 设置 `SA_IMAGE`：

- 按提交固定：`ghcr.io/sdxdlgz/search-anywhere:sha-完整提交哈希`
- 按摘要固定：`ghcr.io/sdxdlgz/search-anywhere@sha256:镜像摘要`
- 按版本固定：仅使用[镜像页面](https://github.com/users/sdxdlgz/packages/container/package/search-anywhere)中实际已发布的版本标签

然后执行更新命令。数据库回退需要升级前备份及兼容的程序版本；旧程序不保证能读取新版本数据库。

## 源码运行

需要 Node.js 24 或以上，支持 Windows、macOS 和 Linux。

```bash
git clone https://github.com/sdxdlgz/search-anywhere.git
cd search-anywhere
npm ci
npm run build
npm start
```

在另一个终端运行 `npm run admin:token` 获取管理员口令，打开 <http://localhost:8765> 登录。开发模式使用 `npm run dev`。

可将 `.env.example` 复制为 `.env` 后修改。源码启动会读取此文件；已有进程环境变量优先。Compose 只传递 `compose.yaml` 中明确声明的变量，数据目录在容器内固定为 `/app/data`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SA_HOST` | `127.0.0.1` | 源码监听地址；容器内部固定为 `0.0.0.0` |
| `SA_PORT` | `8765` | 源码监听端口；Compose 中表示宿主机发布端口 |
| `SA_DATA_DIR` | `.data` | 源码数据目录；容器内部为 `/app/data` |
| `SA_ADMIN_TOKEN` | 自动生成 | 管理员口令，显式设置时至少 16 个字符 |
| `SA_TRUST_PROXY` | 不信任转发头 | 可设 `loopback`、0–16 跳数，或逗号分隔的可信 IP/CIDR |
| `SA_ALLOWED_ORIGINS` | 仅同源 | 额外允许的浏览器 Origin，逗号分隔；仅对 `/v1` 和 `/mcp` 生效 |
| `SA_IMAGE` | `ghcr.io/sdxdlgz/search-anywhere:latest` | 仅 Compose：选择镜像标签或摘要 |
| `SA_BIND` | `127.0.0.1` | 仅 Compose：宿主机端口绑定地址 |

## 数据持久化

每个数据目录只能供一个网关进程使用，不要让多个容器共用同一 SQLite 卷。供应商凭证依赖本地 `encryption.key` 解密；目录迁移时数据库和密钥必须配套。

默认开启自动清理，保留最近 7 天的搜索词、结果、正文和调用日志内容；升级后的旧配置也使用此默认值。控制台“备份与迁移 → 历史数据清理”可修改天数、关闭或手动清理。需要长期保存证据时，请先调整策略或导出备份。[清理机制与计费记录](history-retention.md)

SQLite 会复用清理产生的空闲页面，主数据库文件通常不会立即缩小。精简计费记录继续保留并缓慢增长；清理不会删除已导出的备份或 Docker 日志。仍应监控磁盘空间。项目不提供定时备份；网页备份的大小限制、恢复步骤和停机目录迁移见[备份与迁移](backup-migration.md)。

## 开发验证

```bash
npm test
npm run build
```

后端测试使用临时数据库和模拟供应商响应，不需要真实搜索 key。

浏览器验收需要 Python Playwright 及 Chromium。在一个终端运行 `node --import tsx tests/browser-server.ts`，另一个终端运行 `python tests/browser_test.py`。迁移专项使用 `python tests/backups_browser_test.py`，清理专项使用 `python tests/retention_browser_test.py`；每次专项应新启动测试服务器，以隔离数据。

容器检查需要本地 Docker：

```bash
docker build -t search-anywhere:test .
python scripts/container-smoke.py
```

脚本使用独立容器、数据卷与模拟凭证，检查非 root / 只读运行、文件权限、重启持久化及跨实例加密恢复。

## 镜像发布

[GitHub Actions](../.github/workflows/image.yml)在 PR 上执行验证；`main` 推送或 `v*` 标签通过验证后发布 GHCR 镜像。两种架构分别在原生运行器上完成容器检查后才进入发布步骤。

标签包括 `latest`、`main` 和 `sha-完整提交哈希`；版本标签发布会生成对应语义版本镜像。流程使用仓库自带的 `GITHUB_TOKEN`，不需要个人注册表密码。

Fork 发布时，需要调整工作流中的仓库条件、镜像命名空间及 Compose 默认镜像。首次发布自己的 GHCR 包后，应检查包可见性；公开包才能供匿名客户端拉取。
