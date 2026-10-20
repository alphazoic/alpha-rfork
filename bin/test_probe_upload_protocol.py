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

    def test_restart_probe_is_explicit_and_selects_only_restart_test(self):
        def command(args, **kwargs):
            self.assertEqual(args[args.index('-run') + 1], '^TestLiveUploadRestartProtocol$')
            self.assertEqual(kwargs['env']['RFORK_LIVE_RESTART'], '1')
            self.assertNotIn('RFORK_RESTART_PHASE', kwargs['env'])
            self.assertNotIn('RFORK_LIVE_PROTOCOL', kwargs['env'])
            self.assertEqual(json.loads(self.receipt.read_text())['probe'], 'restart')
            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

        with patch.dict(os.environ, {'RFORK_RESTART_PHASE': 'finish', 'RFORK_LIVE_PROTOCOL': '1'}), \
                patch.object(probe.subprocess, 'run', side_effect=command), \
                contextlib.redirect_stdout(io.StringIO()):
            probe.run(resume=True)

    def test_cleanup_failure_reports_categories_without_private_output(self):
        private = 'https://private.invalid/capability secret-password'
        def command(args, **kwargs):
            if args[1]=='obscure': return subprocess.CompletedProcess(args,0,stdout='obscured\n')
            return subprocess.CompletedProcess(args,1,stdout='',stderr='could not login: User blocked '+private)
        with patch.dict(os.environ,{'RFORK_MEGA_EMAIL':'account@example.invalid','RFORK_MEGA_PASSWORD':'secret-password'}), \
                patch.object(probe.subprocess,'run',side_effect=command):
            with self.assertRaisesRegex(RuntimeError,'output withheld'): probe.cleanup()
        report=json.loads(self.receipt.read_text())
        self.assertIn('blocked',report['cleanupFailure']['categories'])
        self.assertNotIn(private,self.receipt.read_text())

    def test_prepare_cleanup_rejects_arbitrary_folder(self):
        with self.assertRaisesRegex(RuntimeError,'unrecognized'): probe.prepare_cleanup('ordinary-user-folder')

    def test_account_access_is_read_only_and_does_not_claim_old_account_cleanup(self):
        calls=[]
        def command(args,**kwargs):
            calls.append(args[1])
            self.assertNotIn('RFORK_MEGA_PASSWORD',kwargs['env'])
            if args[1]=='obscure': return subprocess.CompletedProcess(args,0,stdout='obscured\n')
            self.assertEqual(args[1:3],['lsjson','rforkproto:'])
            return subprocess.CompletedProcess(args,0,stdout='[{"Name":"private-user-folder"}]',stderr='')
        with patch.dict(os.environ,{'RFORK_MEGA_EMAIL':'test@example.invalid','RFORK_MEGA_PASSWORD':'secret'}), \
                patch.object(probe.subprocess,'run',side_effect=command),contextlib.redirect_stdout(io.StringIO()):
            probe.check_account()
        report=json.loads(self.receipt.read_text())
        self.assertTrue(report['accountAccess'])
        self.assertIsNone(report['cleanup'])
        self.assertNotIn('private-user-folder',self.receipt.read_text())
        self.assertEqual(calls,['obscure','lsjson'])

    def test_account_access_failure_withholds_private_output(self):
        def command(args,**kwargs):
            if args[1]=='obscure':return subprocess.CompletedProcess(args,0,stdout='obscured\n')
            return subprocess.CompletedProcess(args,1,stdout='',stderr='User blocked https://private.invalid secret')
        with patch.dict(os.environ,{'RFORK_MEGA_EMAIL':'test@example.invalid','RFORK_MEGA_PASSWORD':'secret'}), \
                patch.object(probe.subprocess,'run',side_effect=command),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError,'output withheld'):probe.check_account()
        report=json.loads(self.receipt.read_text())
        self.assertFalse(report['accountAccess'])
        self.assertNotIn('private.invalid',self.receipt.read_text())


if __name__ == '__main__':
    unittest.main()
