#!/usr/bin/env python3
"""Package the three alpha targets, licenses, provenance and checksums."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time
import zipfile

root = Path(__file__).resolve().parent.parent


def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args]).decode().strip()


if git('status', '--porcelain'):
    raise SystemExit('Commit the reviewed source and reports before packaging')
version = (root / 'RFORK_VERSION').read_text().strip()
commit = git('rev-parse', 'HEAD')
epoch = int(git('show', '-s', '--format=%ct', 'HEAD'))
destination = root / 'dist' / version
destination.mkdir(parents=True, exist_ok=True)
manifest = {
    'version': version,
    'sourceCommit': commit,
    'toolchain': 'go1.26.9',
    'upstream': json.loads((root / 'UPSTREAM.json').read_text()),
    'releaseStatus': 'experimental alpha; M3 bundle unchanged',
    'artifacts': [],
}


def add_tar(archive, name, data, mode=0o644):
    member = tarfile.TarInfo(name)
    member.size, member.mtime, member.mode = len(data), epoch, mode
    archive.addfile(member, io.BytesIO(data))


for system in ['linux', 'windows', 'darwin']:
    suffix = '.exe' if system == 'windows' else ''
    binary = root / 'build' / f'rfork-{system}-amd64{suffix}'
    if not binary.exists():
        raise SystemExit(f'Missing binary: {binary}')
    validation = 'cross-built; native runtime and live MEGA validation pending'
    if system == 'linux':
        reports = [json.loads((root / 'reports' / f'{phase}.json').read_text())
                   for phase in ['smoke', 'speed', 'large']]
        if all(report.get('success') and report.get('cleanup', {}).get('remoteAbsenceVerified')
               for report in reports):
            validation = 'native CLI, unit/race, live integrity, cancellation and speed checks passed'
        else:
            raise SystemExit('Linux live validation/cleanup incomplete')
        if hashlib.sha256(binary.read_bytes()).hexdigest() != reports[-1]['forkSHA256']:
            raise SystemExit('Linux binary differs from the verified 2 GiB test build')
    info = {'target': f'{system}/amd64', 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'runtimeValidation': validation}
    files = {
        'rfork' + suffix: binary.read_bytes(),
        'README.md': (f'Binary alpha archive. Build instructions refer to the accompanying rfork-{version}-source.tar.gz.\n\n'.encode()
                      + (root / 'RFORK_README.md').read_bytes()),
        'RFORK_CHANGELOG.md': (root / 'RFORK_CHANGELOG.md').read_bytes(),
        'PLAN.md': (root / 'PLAN.md').read_bytes(),
        'M3_INTEGRATION.md': (root / 'M3_INTEGRATION.md').read_bytes(),
        'UPSTREAM.json': (root / 'UPSTREAM.json').read_bytes(),
        'deps/go-mega/RFORK.md': (root / 'deps/go-mega/RFORK.md').read_bytes(),
        'LICENSE': (root / 'COPYING').read_bytes(),
        'LICENSE-go-mega': (root / 'deps/go-mega/LICENSE').read_bytes(),
        'RELEASE.json': (json.dumps({**info, 'version': version, 'sourceCommit': commit}, indent=2) + '\n').encode(),
    }
    for report in sorted((root / 'reports').iterdir()):
        if report.is_file():
            files['reports/' + report.name] = report.read_bytes()
    archive_name = f'rfork-{version}-{system}-amd64' + ('.zip' if system == 'windows' else '.tar.gz')
    archive_path = destination / archive_name
    if system == 'windows':
        with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in files.items():
                member = zipfile.ZipInfo(name, time.gmtime(epoch)[:6])
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = 0o100644 << 16
                archive.writestr(member, content)
    else:
        with archive_path.open('wb') as output:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=epoch) as compressed:
                with tarfile.open(fileobj=compressed, mode='w') as archive:
                    for name, content in files.items():
                        add_tar(archive, name, content, 0o755 if name == 'rfork' else 0o644)
    manifest['artifacts'].append({**info, 'file': archive_name,
                                  'archiveSHA256': hashlib.sha256(archive_path.read_bytes()).hexdigest()})

source_name = f'rfork-{version}-source.tar.gz'
source_tar = subprocess.check_output(['git', '-C', str(root), 'archive', '--format=tar',
                                      f'--prefix=rfork-{version}/', 'HEAD'])
(destination / source_name).write_bytes(gzip.compress(source_tar, mtime=epoch))
manifest['sourceArchive'] = source_name
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
checksums = []
for item in sorted(destination.iterdir()):
    if item.name != 'SHA256SUMS' and item.is_file():
        checksums.append(f'{hashlib.sha256(item.read_bytes()).hexdigest()}  {item.name}')
(destination / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
print(destination)
