#!/usr/bin/env python3
"""Offline boundaries for the integrated native resume runner."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('live_resume',Path(__file__).with_name('live-upload-resume.py'))
live=importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class ResumeRunnerTest(unittest.TestCase):
    def fixture(self,source):
        test=live.UploadResumeTest.__new__(live.UploadResumeTest)
        test.report={'remoteFolder':'rfork-ci-linux-'+'a'*8+'-'+'a'*4+'-'+'a'*4+'-'+'a'*4+'-'+'a'*12,'checks':[]}
        test.fork=Path('rfork')
        test.save=Mock()
        output={'status':'committed','node':'private-node','restoredAcknowledgedBytes':8,'pendingSourceBytes':source.stat().st_size-8,'sourceBytesRead':source.stat().st_size}
        record={}
        test.command=Mock(return_value=(SimpleNamespace(stdout=json.dumps(output)),record))
        return test,record,output

    def test_explicit_source_state_and_settings_without_publishing_node(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';source.write_bytes(bytes(17))
            state=Path(directory)/'state'
            test,record,_=self.fixture(source)
            result=test.resume(source,'file.bin',state,min_restored=1)
            self.assertEqual(result['node'],'private-node')
            args=test.command.call_args.args[1]
            self.assertEqual(args[:2],['backend','upload-resume'])
            self.assertIn(str(source.resolve()),args)
            self.assertIn('checkpoint='+str(state.resolve()),args)
            self.assertEqual(args[args.index('--mega-upload-concurrency')+1],'2')
            self.assertEqual(args[args.index('--mega-upload-request-size')+1],'1Mi')
            self.assertNotIn('private-node',json.dumps(record))

    def test_rejects_false_success_and_inconsistent_resume_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';source.write_bytes(bytes(17))
            for field,value in [('status','already-committed'),('sourceBytesRead',16),('restoredAcknowledgedBytes',0),('pendingSourceBytes',18)]:
                test,_,output=self.fixture(source)
                output[field]=value
                test.command.return_value=(SimpleNamespace(stdout=json.dumps(output)),{})
                with self.assertRaises(RuntimeError):test.resume(source,'file.bin',Path(directory)/'state',min_restored=1)

    def test_checkpoint_growth_is_only_an_interruption_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'state';state.mkdir()
            snapshot=state/'state';snapshot.write_bytes(bytes(100))
            process=Mock();process.poll.return_value=None
            def grow(_):snapshot.write_bytes(bytes(130))
            with patch.object(live.time,'sleep',side_effect=grow):
                live.wait_checkpoint_progress(process,state,timeout=1)
            process.poll.return_value=0
            with self.assertRaisesRegex(RuntimeError,'ended before'):
                live.wait_checkpoint_progress(process,state,timeout=1)

    def test_private_config_reuses_sessions_and_fresh_auth_removes_only_session_keys(self):
        test=live.UploadResumeTest.__new__(live.UploadResumeTest)
        test.env={'RCLONE_CONFIG_CITEST_USER':'test@example.invalid','RCLONE_CONFIG_CITEST_PASS':'obscured-secret'}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'config'
            test.configure_private_login(path)
            self.assertEqual(test.env['RCLONE_CONFIG'],str(path))
            self.assertNotIn('RCLONE_CONFIG_CITEST_USER',test.env)
            with path.open('a') as out:out.write('session_id = private-session\nmaster_key = private-key\n')
            test.fresh_authentication()
            text=path.read_text()
            self.assertNotIn('private-session',text)
            self.assertNotIn('private-key',text)
            self.assertIn('obscured-secret',text)


if __name__=='__main__':unittest.main()
