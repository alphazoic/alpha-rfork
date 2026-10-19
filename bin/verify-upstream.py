#!/usr/bin/env python3
"""Compare the recorded supplied source with the official release archive."""
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
archive = root / 'build/rclone-v1.75.2-source.tar.gz'
archive.parent.mkdir(parents=True, exist_ok=True)
url = 'https://codeload.github.com/rclone/rclone/tar.gz/refs/tags/v1.75.2'
if not archive.exists():
    with urllib.request.urlopen(url, timeout=120) as response:
        archive.write_bytes(response.read())
reference = root / 'build/upstream-source'
receipt = root / 'UPSTREAM.json'
if receipt.exists():
    expected = json.loads(receipt.read_text())['archiveSHA256']
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise SystemExit('Upstream archive checksum mismatch')
prepare = not (reference / 'go.mod').exists()
official = {}
with tarfile.open(archive) as source:
    for entry in source:
        if entry.isfile():
            name = entry.name.split('/', 1)[1]
            content = source.extractfile(entry).read()
            official[name] = hashlib.sha256(content).hexdigest()
            if prepare:
                target = reference / name
                if not target.resolve().is_relative_to(reference.resolve()):
                    raise SystemExit('Invalid archive path')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
local = {str(p.relative_to(reference)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in reference.rglob('*') if p.is_file()}
result = {'version': 'v1.75.2', 'sourceURL': url,
          'archiveSHA256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'missing': sorted(official.keys() - local.keys()),
          'extra': sorted(local.keys() - official.keys()),
          'changed': sorted(k for k in official.keys() & local.keys() if official[k] != local[k]),
          'officialFileCount': len(official)}
(root / 'UPSTREAM.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
if result['missing'] or result['extra'] or result['changed']:
    raise SystemExit(1)
