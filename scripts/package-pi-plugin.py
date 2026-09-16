"""Build a credential-free, store-only PI-Desktop plugin from an explicit file list."""
import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'plugins' / 'pi-desktop'
FILES = ['main.cjs', 'client.cjs', 'config.cjs', 'tasks.cjs', 'tools.cjs',
         'renderer/index.html', 'renderer/panel.js', 'renderer/style.css', 'README.md']


def package(gateway: str, output: Path) -> Path:
    parsed = urlsplit(gateway)
    hostname = parsed.hostname
    local = hostname in ('localhost', '127.0.0.1')
    if hostname and ':' in hostname:
        raise ValueError('PI-Desktop requires a hostname or IPv4 in the network manifest.')
    if not hostname or (parsed.scheme != 'https' and not (parsed.scheme == 'http' and local)):
        raise ValueError('Use HTTPS for a remote gateway, or HTTP for loopback.')
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Gateway must not contain credentials, query parameters or fragments.')
    if parsed.path.rstrip('/').endswith(('/mcp', '/v1')):
        raise ValueError('Use the gateway base URL without /mcp or /v1.')
    parsed.port  # Validate the port before generating an installable package.
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    manifest['net']['domains'] = [hostname if hostname != '::1' else '[::1]']
    node = "const {tools}=require('./plugins/pi-desktop/tools.cjs');process.stdout.write(JSON.stringify(tools.map(({endpoint,...tool})=>tool)))"
    manifest['contributes']['agentTools'] = json.loads(subprocess.check_output(['node', '-e', node], cwd=ROOT, encoding='utf-8'))
    entries = {name: (SOURCE / name).read_bytes() for name in FILES}
    entries['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    entries['defaults.json'] = (json.dumps({'gateway': gateway.rstrip('/')}) + '\n').encode()
    checksums = {'algorithm': 'sha256', 'files': {name: hashlib.sha256(data).hexdigest() for name, data in entries.items()}}
    entries['checksums.json'] = (json.dumps(checksums, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"{manifest['id']}-{manifest['version']}.piplug"
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix('.piplug.sha256').write_text(f'{digest}  {destination.name}\n', encoding='utf-8')
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', default='http://localhost:8765')
    parser.add_argument('--out', type=Path, default=ROOT / 'dist' / 'pi-desktop')
    args = parser.parse_args()
    try:
        print(package(args.gateway, args.out))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Plugin packaging failed: {type(error).__name__}\n')
