import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
const path = resolve(process.env.SA_DATA_DIR || '.data', 'admin-token.txt');
try { console.log(process.env.SA_ADMIN_TOKEN || readFileSync(path, 'utf8').trim()); }
catch { console.error('请先启动服务，管理员口令会在首次启动时创建。'); process.exitCode = 1; }
