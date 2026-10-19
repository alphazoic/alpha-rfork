#!/usr/bin/env python3
"""Fetch a checksum-verified, project-local static-analysis tool."""
import hashlib
from pathlib import Path
import tarfile
import urllib.request

version = '2.15.0'
root = Path(__file__).resolve().parent.parent
tools = root / 'build/tools'
tools.mkdir(parents=True, exist_ok=True)
name = f'golangci-lint-{version}-linux-amd64.tar.gz'
base = f'https://github.com/golangci/golangci-lint/releases/download/v{version}/'
archive = tools / name
if not archive.exists():
    with urllib.request.urlopen(base + name, timeout=120) as response:
        archive.write_bytes(response.read())
with urllib.request.urlopen(base + f'golangci-lint-{version}-checksums.txt', timeout=60) as response:
    sums = response.read().decode()
expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1].lstrip('*') == name)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Tool checksum mismatch')
with tarfile.open(archive) as package:
    binary = package.extractfile(f'golangci-lint-{version}-linux-amd64/golangci-lint').read()
target = tools / 'golangci-lint'
target.write_bytes(binary)
target.chmod(0o700)
print(str(target))
