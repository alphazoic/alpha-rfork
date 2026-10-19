#!/usr/bin/env python3
"""Manually dispatched native MEGA checks; reports exclude credentials and links."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parent.parent
MIB = 1024 * 1024


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class LiveTest:
    def __init__(self, target, cleanup_only=False):
        self.target = target
        suffix = '.exe' if target == 'windows' else ''
        self.fork = ROOT / f'build/rfork-{target}-amd64{suffix}'
        self.stock = ROOT / f'build/rclone-v1.75.2-stock{suffix}'
        self.receipt = ROOT / f'build/live-mega-{target}.json'
        self.report = None
        if cleanup_only:
            if self.receipt.exists():
                self.report = json.loads(self.receipt.read_text())
        else:
            self.report = {
                'target': target, 'commit': os.environ.get('GITHUB_SHA'),
                'remoteFolder': f'rfork-ci-{target}-{uuid.uuid4()}',
                'binarySHA256': sha256(self.fork), 'verifierSHA256': sha256(self.stock),
                'checks': [], 'status': 'running', 'cleanup': False,
            }
            self.save()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('RCLONE_', 'RFORK_MEGA_'))}
        self.env.update(RCLONE_CONFIG=os.devnull, RCLONE_CONFIG_CITEST_TYPE='mega')

    def save(self):
        self.receipt.parent.mkdir(parents=True, exist_ok=True)
        self.receipt.write_text(json.dumps(self.report, indent=2) + '\n')

    def login(self):
        email = os.environ.get('RFORK_MEGA_EMAIL', '')
        password = os.environ.get('RFORK_MEGA_PASSWORD', '')
        if not email or not password or '\n' in password or '\r' in password:
            raise RuntimeError('Missing or unsupported MEGA account secrets')
        obscured = subprocess.run([str(self.fork), 'obscure', '-'],
                                  input=password + '\n', text=True, capture_output=True,
                                  env=self.env, timeout=30, check=True).stdout.strip()
        self.env.update(RCLONE_CONFIG_CITEST_USER=email, RCLONE_CONFIG_CITEST_PASS=obscured)

    def command(self, binary, args, label, expected_code=0, timeout=900):
        print(f'Starting {label}', flush=True)
        started = time.monotonic()
        try:
            result = subprocess.run([
                str(binary), *args, '--retries', '1', '--low-level-retries', '3',
                '--contimeout', '20s', '--timeout', '60s', '--mega-use-https=true',
                '--mega-hard-delete=true', '--use-json-log', '--stats', '1s',
                '--stats-log-level', 'NOTICE',
            ], capture_output=True, text=True, env=self.env, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'{label}: process exceeded {timeout}s') from None
        seconds = round(time.monotonic() - started, 3)
        # Persist only structured transfer counters, never raw backend messages.
        stats = []
        for line in result.stderr.splitlines():
            try:
                item = json.loads(line)
                if 'stats' in item:
                    stats.append(item['stats'])
            except (ValueError, TypeError):
                pass
        record = {'label': label, 'exitCode': result.returncode, 'seconds': seconds,
                  'bytes': max((s.get('bytes', 0) for s in stats), default=0)}
        if result.returncode != expected_code:
            messages = result.stderr.lower()
            record['errorCategories'] = [name for name, pattern in (
                ('authentication', r'password|login|authentication|session|two.factor'),
                ('quota', r'quota|over.?quota|bandwidth|storage.*exceed'),
                ('timeout', r'timeout|timed out|deadline'),
                ('network', r'connection|no such host|tls|network|http.*[45][0-9]{2}'),
                ('integrity', r'mac verification|corrupt|checksum'),
            ) if re.search(pattern, messages)]
        self.report['checks'].append(record)
        self.save()
        print(json.dumps(record), flush=True)
        if result.returncode != expected_code:
            raise RuntimeError(f'{label}: exit {result.returncode}, expected {expected_code}; '
                               'raw output withheld to keep account data out of artifacts')
        return result, record

    @property
    def remote(self):
        folder = self.report['remoteFolder']
        if not re.fullmatch(r'rfork-ci-(windows|darwin)-[a-f0-9-]{36}', folder):
            raise RuntimeError('Refusing cleanup of an unrecognized test folder')
        return 'citest:' + folder

    def listing(self, subfolder=''):
        result, _ = self.command(self.stock, ['lsjson', self.remote + subfolder], 'list' + subfolder)
        return json.loads(result.stdout)

    def upload(self, source, name, workers):
        _, record = self.command(self.fork, ['copyto', str(source), self.remote + '/' + name,
                                           '--transfers', '1', '--mega-upload-concurrency', str(workers)],
                                 f'upload {name} workers={workers}')
        record.update(fileBytes=source.stat().st_size, workers=workers)
        self.save()

    def verify(self, source, name, work):
        target = work / 'download.bin'
        target.unlink(missing_ok=True)
        self.command(self.stock, ['copyto', self.remote + '/' + name, str(target)],
                     'stock download ' + name)
        expected, actual = sha256(source), sha256(target)
        check = {'label': 'SHA256 ' + name, 'expected': expected, 'actual': actual,
                 'matches': expected == actual}
        self.report['checks'].append(check)
        self.save()
        if expected != actual:
            raise RuntimeError('SHA256 mismatch: ' + name)
        target.unlink()

    def cleanup(self):
        if not self.report or self.report['cleanup']:
            return
        self.command(self.fork, ['purge', self.remote], 'purge test folder', timeout=180)
        # Verify absence with a fresh process and stock client.
        result, _ = self.command(self.stock, ['lsjson', 'citest:', '--dirs-only'], 'verify cleanup')
        if any(entry['Name'] == self.report['remoteFolder'] for entry in json.loads(result.stdout)):
            raise RuntimeError('Test folder remains after cleanup')
        self.report['cleanup'] = True
        self.save()

    def run(self):
        self.login()
        try:
            self.command(self.fork, ['mkdir', self.remote], 'create isolated test folder')
            with tempfile.TemporaryDirectory(prefix='rfork-live-') as directory:
                work = Path(directory)
                payload = work / 'payload.bin'
                with payload.open('wb') as stream:
                    for _ in range(512):
                        stream.write(os.urandom(MIB))
                self.report['payloadSHA256'] = sha256(payload)
                for workers in (1, 4, 8):
                    name = f'payload-{workers}.bin'
                    self.upload(payload, name, workers)
                    self.verify(payload, name, work)
                    self.command(self.fork, ['deletefile', self.remote + '/' + name], 'delete ' + name)
                small = work / 'boundary.bin'
                for size in (0, 1, 15, 16, 17, 131071, 131072, 131073, 8 * MIB + 31):
                    small.write_bytes(os.urandom(size))
                    name = f'boundary-{size}.bin'
                    self.upload(small, name, 8)
                    self.verify(small, name, work)
                small.write_bytes(os.urandom(MIB + 17))
                self.upload(small, 'replacement.bin', 4)
                self.verify(small, 'replacement.bin', work)
                small.write_bytes(os.urandom(MIB + 31))
                self.upload(small, 'replacement.bin', 8)
                self.verify(small, 'replacement.bin', work)
                if sum(e['Name'] == 'replacement.bin' for e in self.listing()) != 1:
                    raise RuntimeError('Replacement left duplicate files')
                linked, _ = self.command(self.fork, ['link', self.remote + '/replacement.bin'], 'create share link')
                if not re.match(r'https://mega\.(nz|co\.nz)/', linked.stdout.strip()):
                    raise RuntimeError('Invalid share link')
                cancel = work / 'cancel'
                cancel.mkdir()
                payload.rename(cancel / 'cancelled.bin')
                # A hard transfer deadline cancels the Go context on both native OSes.
                # Throttling ensures the file cannot finish before that deadline.
                _, record = self.command(self.fork, [
                    'copy', str(cancel), self.remote + '/cancel', '--transfers', '1',
                    '--mega-upload-concurrency', '8', '--bwlimit', '1M',
                    '--max-duration', '12s', '--cutoff-mode', 'hard',
                ], 'cancel active upload', expected_code=10, timeout=60)
                if not 0 < record['bytes'] < 512 * MIB or record['seconds'] > 40:
                    raise RuntimeError('Cancellation did not interrupt an active transfer promptly')
                if self.listing('/cancel'):
                    raise RuntimeError('Cancelled upload published an object')
                self.report['status'] = 'success'
        except BaseException as error:
            self.report['status'] = 'failure'
            self.report['error'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            raise
        finally:
            self.save()
            self.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['run', 'cleanup'])
    parser.add_argument('--target', required=True, choices=['windows', 'darwin'])
    args = parser.parse_args()
    test = LiveTest(args.target, cleanup_only=args.mode == 'cleanup')
    if args.mode == 'run':
        test.run()
    elif test.report and not test.report['cleanup']:
        test.login()
        test.cleanup()


if __name__ == '__main__':
    main()
