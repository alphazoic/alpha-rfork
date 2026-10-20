#!/usr/bin/env python3
"""Native CLI integrity and cancellation checks; no performance-setting rankings."""
import argparse
import importlib.util
import os
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('live_mega', Path(__file__).with_name('live-mega.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
MIB = 1024 * 1024


class UploadImprovementTest(base.LiveTest):
    def __init__(self, target, cleanup_only=False):
        super().__init__(target, cleanup_only=cleanup_only, receipt_prefix='upload-improvements-live')

    def upload_settings(self, source, name, request_size, pacing='0', max_connections=0):
        args = ['copyto', str(source), self.remote + '/' + name, '--transfers', '1',
                '--mega-upload-concurrency', '8', '--mega-upload-request-size', str(request_size)+'B',
                '--mega-upload-pacing', pacing, '--mega-upload-retries', '1',
                '--mega-upload-retry-body-errors=true', '--mega-upload-diagnostics',
                '--max-connections', str(max_connections)]
        _, record = self.command(self.fork, args, 'upload ' + name)
        record.update(fileBytes=source.stat().st_size, workers=8, requestSizeBytes=request_size,
                      pacing=pacing, maxConnections=max_connections)
        self.save()
        pacing_seconds = 0 if pacing == '0' else float(pacing.removesuffix('ms')) / 1000
        self.assert_diagnostics(record, [source.stat().st_size], request_size, max_connections,
                                workers=8, pacing_seconds=pacing_seconds, retry_limit=1, retry_body_errors=True)
        return record

    def assert_diagnostics(self, record, sizes, request_size, max_connections=0,
                           workers=None, pacing_seconds=None, retry_limit=None, retry_body_errors=None):
        diagnostics = record.get('uploadDiagnostics', [])
        if len(diagnostics) != len(sizes):
            raise RuntimeError('Missing per-file upload diagnostics')
        if sorted(d['sourceBytes'] for d in diagnostics) != sorted(sizes):
            raise RuntimeError('Source byte diagnostics do not match inputs')
        for data in diagnostics:
            if not data['committed'] or not data['successful']:
                raise RuntimeError('Successful CLI upload lacks confirmed commit')
            chunks = data['chunks']
            for key, expected in [('workers', workers), ('pacingSeconds', pacing_seconds),
                                  ('retryLimit', retry_limit), ('retryBodyErrors', retry_body_errors)]:
                if expected is not None and data[key] != expected:
                    raise RuntimeError('CLI upload settings do not match diagnostics: ' + key)
            if chunks['acknowledgedBytes'] != data['sourceBytes'] or chunks['activeRequests'] != 0:
                raise RuntimeError('Incorrect acknowledgement or joined-request accounting')
            if data['requestSizeBytes'] != request_size or chunks['maxRequestBytes'] > (request_size or MIB):
                raise RuntimeError('Configured request-size bound was not respected')
            if max_connections and chunks['peakRequests'] > max_connections:
                raise RuntimeError('Upload bypassed explicit connection admission limit')
            if workers and chunks['peakRequests'] > workers:
                raise RuntimeError('Upload bypassed its worker-count bound')
            if request_size > MIB and data['sourceBytes'] > 2 * MIB and chunks['maxRequestBytes'] <= MIB:
                raise RuntimeError('Batching flag did not produce a multi-chunk request')

    def run(self):
        self.login()
        try:
            self.command(self.fork, ['mkdir', self.remote], 'create isolated test folder')
            with tempfile.TemporaryDirectory(prefix='rfork-upload-improvements-') as directory:
                work = Path(directory)
                payload = work / 'payload.bin'
                with payload.open('wb') as stream:
                    for _ in range(64):
                        stream.write(os.urandom(MIB))
                    stream.write(os.urandom(31))
                # Configuration coverage and protocol/resource bounds, not tuning.
                for name, request_size, pacing, connections in (
                        ('native.bin', 0, '10ms', 0),
                        ('batch-4Mi.bin', 4 * MIB, '0', 2),
                        ('batch-8Mi.bin', 8 * MIB, '1ms', 0),
                        ('batch-64Mi.bin', 64 * MIB, '0', 0)):
                    self.upload_settings(payload, name, request_size, pacing, connections)
                    self.verify(payload, name, work)
                    self.command(self.fork, ['deletefile', self.remote + '/' + name], 'delete ' + name)
                small = work / 'boundary.bin'
                for size in (0, 1, 15, 16, 17, 131073, 4 * MIB + 31):
                    small.write_bytes(os.urandom(size))
                    name = f'boundary-{size}.bin'
                    self.upload_settings(small, name, 2 * MIB)
                    self.verify(small, name, work)
                for size in (MIB + 17, MIB + 31):
                    small.write_bytes(os.urandom(size))
                    self.upload_settings(small, 'replacement.bin', 4 * MIB)
                    self.verify(small, 'replacement.bin', work)
                if sum(e['Name'] == 'replacement.bin' for e in self.listing()) != 1:
                    raise RuntimeError('Replacement left duplicate files')
                multi = work / 'multi'
                multi.mkdir()
                for name in ('first.bin', 'second.bin'):
                    (multi / name).write_bytes(os.urandom(8 * MIB + 31))
                _, record = self.command(self.fork, ['copy', str(multi), self.remote + '/multi',
                    '--transfers', '2', '--mega-upload-concurrency', '5',
                    '--mega-upload-request-size', '4Mi', '--mega-upload-pacing', '0',
                    '--max-connections', '4', '--mega-upload-diagnostics'], 'simultaneous files')
                self.assert_diagnostics(record, [8 * MIB + 31] * 2, 4 * MIB, 4,
                                        workers=5, pacing_seconds=0, retry_limit=3, retry_body_errors=False)
                for name in ('first.bin', 'second.bin'):
                    self.verify(multi / name, 'multi/' + name, work)
                cancel = work / 'cancel'
                cancel.mkdir()
                payload.rename(cancel / 'cancelled.bin')
                _, record = self.command(self.fork, ['copy', str(cancel), self.remote + '/cancel',
                    '--transfers', '1', '--mega-upload-concurrency', '8',
                    '--mega-upload-request-size', '4Mi', '--mega-upload-pacing', '0',
                    '--bwlimit', '1M', '--max-duration', '12s', '--cutoff-mode', 'hard',
                    '--mega-upload-diagnostics'], 'cancel batched upload', expected_code=10, timeout=60)
                if not 0 < record['bytes'] < 64 * MIB or record['seconds'] > 40:
                    raise RuntimeError('Batched cancellation did not stop an active transfer promptly')
                if any(d['committed'] for d in record.get('uploadDiagnostics', [])):
                    raise RuntimeError('Cancelled upload reported a confirmed commit')
                if self.listing('/cancel'):
                    raise RuntimeError('Cancelled batched upload published an object')
                self.report['status'] = 'success'
        except BaseException as error:
            self.report['status'] = 'failure'
            self.report['error'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            raise
        finally:
            self.save()
            self.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['run', 'cleanup'])
    parser.add_argument('--target', choices=['linux', 'windows', 'darwin'], required=True)
    args = parser.parse_args()
    test = UploadImprovementTest(args.target, cleanup_only=args.mode == 'cleanup')
    if args.mode == 'run':
        test.run()
    elif test.report and not test.report['cleanup']:
        test.login()
        test.cleanup()
