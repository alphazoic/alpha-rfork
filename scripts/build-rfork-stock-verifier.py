"""Build an independent verifier from the pinned official rclone archive."""
import hashlib
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

expected = '68afd7f68c84bd978966feae2116339aa7bf454b39c573910c462e87c3774d5a'
destination = Path(os.environ['M3_STOCK_VERIFIER']).resolve()
destination.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='m3-stock-source-') as directory:
    root = Path(directory)
    archive = root / 'source.tar.gz'
    urllib.request.urlretrieve('https://codeload.github.com/rclone/rclone/tar.gz/refs/tags/v1.75.2', archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise SystemExit('Official verifier archive checksum mismatch')
    with tarfile.open(archive) as source:
        source.extractall(root, filter='data')
    source_root = next(path for path in root.iterdir() if path.is_dir())
    subprocess.run(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false',
                    '-ldflags', '-s -w -X github.com/rclone/rclone/fs.Version=v1.75.2-stock',
                    '-o', str(destination), '.'], cwd=source_root,
                   env={**os.environ, 'CGO_ENABLED': '0', 'GOTOOLCHAIN': 'local'}, check=True)
print('Pinned official source verified; independent stock binary SHA256 ' + hashlib.sha256(destination.read_bytes()).hexdigest())
