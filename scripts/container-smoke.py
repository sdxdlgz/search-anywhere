"""CI-only container checks. Uses isolated volumes and synthetic credentials."""
import json
import os
import struct
import subprocess
import time
import urllib.request
import uuid

IMAGE = os.environ.get("SA_TEST_IMAGE", "search-anywhere:test")
PREFIX = "sa-ci-" + uuid.uuid4().hex[:10]
PASSWORD = "container-backup-fixture-only"
containers, volumes = [], []


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def start(suffix):
    name = PREFIX + "-" + suffix
    volume = name + "-data"
    volumes.append(volume)
    containers.append(name)
    docker("run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-v", volume + ":/app/data", "-p", "127.0.0.1::8765", IMAGE)
    address = docker("port", name, "8765/tcp").splitlines()[0]
    base = "http://" + address
    wait(base)
    return name, base


def wait(base):
    for _ in range(90):
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise AssertionError("Container failed to become healthy")


def request(base, path, cookie=None, body=None, binary=False):
    headers = {"Content-Type": "application/octet-stream" if binary else "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    payload = body if binary else json.dumps(body).encode() if body is not None else None
    return urllib.request.urlopen(urllib.request.Request(base + path, data=payload, headers=headers), timeout=60)


def login(name, base):
    token = docker("exec", name, "node", "scripts/admin-token.mjs")
    with request(base, "/api/session", body={"token": token}) as response:
        return response.headers["Set-Cookie"].split(";")[0]


def upload(archive, confirmation=None):
    metadata = {"password": PASSWORD}
    if confirmation:
        metadata["confirmation_token"] = confirmation
    header = json.dumps(metadata).encode()
    return struct.pack(">I", len(header)) + header + archive


try:
    name, base = start("source")
    assert docker("exec", name, "id", "-u") == "1000"
    assert docker("exec", name, "node", "-e", "console.log((require('node:fs').statSync('/app/data/gateway.sqlite').mode & 0o777).toString(8))") == "600"
    assert docker("exec", name, "node", "-e", "const fs=require('node:fs'); console.log(['.data','.git','src','tests','.env'].some(p=>fs.existsSync('/app/'+p)))") == "false"
    cookie = login(name, base)
    with request(base, "/api/keys", cookie, {"provider": "tavily", "label": "Container fixture", "account": "fixture", "keys": ["container-fixture-key-12345678"]}) as response:
        assert len(json.load(response)) == 1
    with request(base, "/api/backups/export", cookie, {"password": PASSWORD}) as response:
        archive = response.read()
    assert archive.startswith(b"SABACK01") and b"container-fixture-key" not in archive
    docker("restart", "--time", "15", name)
    wait(base)
    cookie = login(name, base)
    with request(base, "/api/keys", cookie) as response:
        assert len(json.load(response)) == 1
    target, target_base = start("target")
    target_cookie = login(target, target_base)
    with request(target_base, "/api/backups/preview", target_cookie, upload(archive), True) as response:
        preview = json.load(response)
    assert preview["summary"]["keys"] == 1
    with request(target_base, "/api/backups/restore", target_cookie, upload(archive, preview["confirmation_token"]), True) as response:
        assert json.load(response)["summary"]["keys"] == 1
    with request(target_base, "/api/keys", target_cookie) as response:
        keys = json.load(response)
    assert keys[0]["label"] == "Container fixture" and "secret" not in keys[0]
    print("Container non-root/read-only runtime, persistent volume, restart and encrypted migration passed")
finally:
    for name in containers:
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, check=False)
    for volume in volumes:
        subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, check=False)
