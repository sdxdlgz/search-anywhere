import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { tools } = require('../plugins/pi-desktop/tools.cjs');

test('PI P4: installable package has store ZIP, root manifest, five declared tools, checksums and no private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-pi-package-'));
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/package-pi-plugin.py', '--gateway', 'https://gateway.example', '--out', dir], { cwd: resolve('.'), encoding: 'utf8' });
    const bytes = await readFile(join(dir, 'sdxdlgz.search-anywhere-0.1.0.piplug'));
    const files: Record<string, Buffer> = {};
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      assert.equal(bytes.readUInt16LE(offset + 8), 0, 'host only supports store compression');
      const size = bytes.readUInt32LE(offset + 18);
      const length = bytes.readUInt16LE(offset + 26);
      const extra = bytes.readUInt16LE(offset + 28);
      const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
      const start = offset + 30 + length + extra;
      files[name] = bytes.subarray(start, start + size);
      offset = start + size;
    }
    const manifest = JSON.parse(files['manifest.json'].toString());
    assert.equal(manifest.id, 'sdxdlgz.search-anywhere');
    assert.deepEqual(manifest.net.domains, ['gateway.example']);
    assert.equal(manifest.contributes.mcpServers, undefined);
    assert.deepEqual(manifest.contributes.agentTools.map((t: any) => t.name), tools.map((t: any) => t.name));
    assert.ok(files[manifest.main]); assert.ok(files[manifest.ui.panel]);
    const checksums = JSON.parse(files['checksums.json'].toString());
    for (const [name, digest] of Object.entries(checksums.files)) assert.equal(createHash('sha256').update(files[name]).digest('hex'), digest);
    assert.deepEqual(Object.keys(files).sort(), ['README.md', 'checksums.json', 'client.cjs', 'config.cjs', 'defaults.json', 'main.cjs', 'manifest.json', 'renderer/index.html', 'renderer/panel.js', 'renderer/style.css', 'tasks.cjs', 'tools.cjs'].sort());
    assert.ok(!bytes.toString().includes('connection.json"')); // No private configuration entry.
    assert.ok(files['renderer/index.html'].toString().includes('type="password"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
