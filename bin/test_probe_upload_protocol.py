#!/usr/bin/env python3
"""Offline checks for protocol-runner cleanup and output boundaries."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('protocol_probe', Path(__file__).with_name('probe-upload-protocol.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProtocolRunnerTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.receipt = Path(self.work.name) / 'receipt.json'
        self.folder = 'rfork-protocol-' + 'a' * 32
        self.record = {'remoteFolder': self.folder, 'status': 'started', 'cleanup': False}
        self.receipt.write_text(json.dumps(self.record))
        self.receipt_patch = patch.object(probe, 'RECEIPT', self.receipt)
        self.receipt_patch.start()
        self.addCleanup(self.receipt_patch.stop)

    def test_refuses_unrecognized_cleanup_before_using_credentials(self):
        self.record['remoteFolder'] = 'ordinary-user-folder'
        self.receipt.write_text(json.dumps(self.record))
        with patch.object(probe.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'unrecognized'):
                probe.cleanup()
            run.assert_not_called()

    def test_scoped_cleanup_verifies_absence_and_strips_inherited_config(self):
        calls = []

        def command(args, **kwargs):
            calls.append(args)
            self.assertNotIn('RFORK_MEGA_PASSWORD', kwargs['env'])
            self.assertNotIn('RCLONE_CONFIG_UNRELATED_PASS', kwargs['env'])
            if args[1] == 'obscure':
                return subprocess.CompletedProcess(args, 0, stdout='obscured\n')
            if args[1] == 'purge':
                self.assertEqual(args[2], 'rforkproto:' + self.folder)
                return subprocess.CompletedProcess(args, 0, stdout='')
            self.assertEqual(args[1:3], ['lsjson', 'rforkproto:'])
            entries = [{'Name': 'keep-user-folder'}]
            if len(calls) == 2:
                entries.append({'Name': self.folder})
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(entries))

        with patch.dict(os.environ, {'RFORK_MEGA_EMAIL': 'test@example.invalid',
                                     'RFORK_MEGA_PASSWORD': 'secret',
                                     'RCLONE_CONFIG_UNRELATED_PASS': 'unrelated'}), \
                patch.object(probe.subprocess, 'run', side_effect=command), \
                contextlib.redirect_stdout(io.StringIO()):
            probe.cleanup()
        self.assertTrue(json.loads(self.receipt.read_text())['cleanup'])
        self.assertEqual(sum(args[1] == 'purge' for args in calls), 1)

    def test_failed_probe_does_not_publish_raw_output(self):
        private = 'private-password-and-upload-url'
        with patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout=private, stderr=private)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaisesRegex(RuntimeError, 'raw output withheld'):
                probe.run()
        self.assertNotIn(private, output.getvalue())
        self.assertEqual(json.loads(self.receipt.read_text())['testExitCode'], 1)


if __name__ == '__main__':
    unittest.main()
