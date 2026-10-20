#!/usr/bin/env python3
"""Offline assertions for the native CLI validation runner."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('live_improvements', Path(__file__).with_name('live-upload-improvements.py'))
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class UploadValidationRunnerTest(unittest.TestCase):
    def fixture(self, size=17, request_size=4*live.MIB):
        test = live.UploadImprovementTest.__new__(live.UploadImprovementTest)
        test.report = {'remoteFolder': 'rfork-ci-linux-' + 'a'*8 + '-' + 'a'*4 + '-' + 'a'*4 + '-' + 'a'*4 + '-' + 'a'*12}
        test.fork = Path('rfork')
        test.save = Mock()
        record = {'uploadDiagnostics': [{'sourceBytes': size, 'committed': True,
                   'successful': True, 'requestSizeBytes': request_size,
                   'workers': 8, 'pacingSeconds': 0, 'retryLimit': 1, 'retryBodyErrors': True,
                   'chunks': {'acknowledgedBytes': size, 'activeRequests': 0,
                              'peakRequests': 1, 'maxRequestBytes': size}}]}
        test.command = Mock(return_value=(None, record))
        return test, record

    def test_upload_settings_uses_explicit_byte_units(self):
        test, _ = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'source'
            source.write_bytes(bytes(17))
            test.upload_settings(source, 'fixture.bin', 4*live.MIB)
        args = test.command.call_args.args[1]
        self.assertEqual(args[args.index('--mega-upload-request-size')+1], '4194304B')

    def test_diagnostics_reject_false_success_and_exceeded_bounds(self):
        test, record = self.fixture()
        for field, value in [('committed', False), ('sourceBytes', 18), ('requestSizeBytes', 0)]:
            changed = copy.deepcopy(record)
            changed['uploadDiagnostics'][0][field] = value
            with self.assertRaises(RuntimeError):
                test.assert_diagnostics(changed, [17], 4*live.MIB)
        for field, value in [('acknowledgedBytes', 18), ('activeRequests', 1),
                             ('maxRequestBytes', 5*live.MIB), ('peakRequests', 3)]:
            changed = copy.deepcopy(record)
            changed['uploadDiagnostics'][0]['chunks'][field] = value
            with self.assertRaises(RuntimeError):
                test.assert_diagnostics(changed, [17], 4*live.MIB, 2)

    def test_diagnostics_detect_ignored_batching(self):
        test, record = self.fixture(size=8*live.MIB)
        record['uploadDiagnostics'][0]['chunks']['maxRequestBytes'] = live.MIB
        with self.assertRaisesRegex(RuntimeError, 'did not produce'):
            test.assert_diagnostics(record, [8*live.MIB], 4*live.MIB)


if __name__ == '__main__':
    unittest.main()
