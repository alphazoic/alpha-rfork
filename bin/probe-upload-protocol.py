#!/usr/bin/env python3
"""Manual small protocol checks with independent verification and scoped cleanup."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parent.parent
RECEIPT = ROOT / 'build/upload-protocol.json'
STOCK = ROOT / 'build/rclone-v1.75.2-stock'


def private_env():
    return {k: v for k, v in os.environ.items()
            if not k.startswith(('RCLONE_', 'RFORK_MEGA_', 'X_MEGA_'))}


def run():
    RECEIPT.parent.mkdir(exist_ok=True)
    report = {'schemaVersion': 1, 'sourceCommit': os.environ.get('GITHUB_SHA'),
              'remoteFolder': 'rfork-protocol-' + uuid.uuid4().hex,
              'status': 'started', 'cleanup': False}
    RECEIPT.write_text(json.dumps(report, indent=2) + '\n')
    env = {**os.environ, 'RFORK_LIVE_PROTOCOL': '1',
           'RFORK_PROTOCOL_REPORT': str(RECEIPT),
           'RFORK_PROTOCOL_STOCK': str(STOCK),
           'RFORK_PROTOCOL_FOLDER': report['remoteFolder'],
           'RFORK_WORKDIR': str(ROOT / 'deps/go-mega')}
    result = subprocess.run([str(ROOT / 'bin/rfork-go'), 'test', '-count=1',
                             '-timeout', '8m', '-run', '^TestLiveUploadProtocol$', '.'],
                            env=env, capture_output=True, text=True, timeout=540)
    # Do not publish raw account/backend output, even when the Go test fails.
    report = json.loads(RECEIPT.read_text())
    report['testExitCode'] = result.returncode
    RECEIPT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    if result.returncode:
        raise RuntimeError('Protocol probe failed; raw output withheld')


def cleanup():
    if not RECEIPT.exists():
        return
    report = json.loads(RECEIPT.read_text())
    folder = report['remoteFolder']
    if not re.fullmatch(r'rfork-protocol-[a-f0-9]{32}', folder):
        raise RuntimeError('Refusing cleanup of an unrecognized folder')
    env = private_env()
    password = os.environ.get('RFORK_MEGA_PASSWORD', '')
    email = os.environ.get('RFORK_MEGA_EMAIL', '')
    if not password or not email:
        raise RuntimeError('Missing dedicated-account secrets for cleanup')
    encoded = subprocess.run([str(STOCK), 'obscure', '-'], input=password + '\n',
                             text=True, capture_output=True, check=True, env=env).stdout.strip()
    env.update(RCLONE_CONFIG='notfound', RCLONE_CONFIG_RFORKPROTO_TYPE='mega',
               RCLONE_CONFIG_RFORKPROTO_USER=email, RCLONE_CONFIG_RFORKPROTO_PASS=encoded)

    def command(args):
        result = subprocess.run([str(STOCK), *args, '--mega-use-https=true',
                                 '--mega-hard-delete=true', '--retries', '1',
                                 '--low-level-retries', '2', '--timeout', '60s'],
                                env=env, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError('Scoped cleanup command failed; output withheld')
        return result.stdout

    entries = json.loads(command(['lsjson', 'rforkproto:', '--dirs-only']))
    if any(e['Name'] == folder for e in entries):
        command(['purge', 'rforkproto:' + folder])
    entries = json.loads(command(['lsjson', 'rforkproto:', '--dirs-only']))
    if any(e['Name'] == folder for e in entries):
        raise RuntimeError('Protocol test folder remains after cleanup')
    report['cleanup'] = True
    RECEIPT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'cleanup': True, 'remoteFolder': folder}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run', 'cleanup'])
    args = parser.parse_args()
    if args.mode == 'run':
        run()
    else:
        cleanup()
