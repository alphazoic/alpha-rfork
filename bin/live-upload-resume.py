#!/usr/bin/env python3
"""Manual native CLI restart checks; fixed settings, private state, stock hashes."""
import argparse
import configparser
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

spec=importlib.util.spec_from_file_location('live_mega',Path(__file__).with_name('live-mega.py'))
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
MIB=1024*1024
NO_RETRY_EXIT=6


def wait_checkpoint_progress(process,directory,timeout=60):
    deadline=time.monotonic()+timeout
    initial=None
    while time.monotonic()<deadline:
        if process.poll() is not None:
            raise RuntimeError('Upload ended before checkpoint interruption')
        try:
            size=(directory/'state').stat().st_size
            if initial is None:initial=size
            elif size>initial:return
        except FileNotFoundError:
            pass
        time.sleep(0.02)
    raise RuntimeError('No checkpoint progress observed before interruption deadline')


class UploadResumeTest(base.LiveTest):
    def __init__(self,target,cleanup_only=False):
        super().__init__(target,cleanup_only=cleanup_only,receipt_prefix='upload-resume-live')

    def configure_private_login(self,path):
        user=self.env.pop('RCLONE_CONFIG_CITEST_USER')
        password=self.env.pop('RCLONE_CONFIG_CITEST_PASS')
        if any(c in user+password for c in '\r\n'):
            raise RuntimeError('Unsupported account configuration')
        self.env.pop('RCLONE_CONFIG_CITEST_TYPE',None)
        with os.fdopen(os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w') as out:
            out.write('[citest]\ntype = mega\nuser = '+user+'\npass = '+password+'\n')
        self.env['RCLONE_CONFIG']=str(path)

    def fresh_authentication(self):
        path=Path(self.env['RCLONE_CONFIG'])
        config=configparser.RawConfigParser()
        config.read(path)
        for option in ('session_id','master_key'):
            config.remove_option('citest',option)
        with path.open('w') as out:config.write(out)

    def resume_args(self,source,name,state):
        return ['backend','upload-resume',self.remote,str(source.resolve()),
                '-o','name='+name,'-o','checkpoint='+str(state.resolve()),
                '-o','checkpoint-interval=50ms','--mega-upload-concurrency','2',
                '--mega-upload-request-size','1Mi','--mega-upload-pacing','10ms',
                '--mega-upload-retries','1','--mega-upload-diagnostics']

    def resume(self,source,name,state,min_restored=0,status='committed'):
        result,record=self.command(self.fork,self.resume_args(source,name,state),'resume '+name,timeout=180)
        try:
            output=json.loads(result.stdout)
            actual_status=output['status']
            restored=output['restoredAcknowledgedBytes']
            pending=output['pendingSourceBytes']
            read=output['sourceBytesRead']
            node=output['node']
        except (ValueError,TypeError,KeyError):
            raise RuntimeError('Missing structured resume result; raw output withheld') from None
        size=source.stat().st_size
        if actual_status!=status or not node or not isinstance(node,str):
            raise RuntimeError('Unexpected resume completion status or node identity')
        if any(type(n) is not int for n in (restored,pending,read)) or not min_restored<=restored<=size:
            raise RuntimeError('Invalid restored acknowledgement count')
        if status=='committed' and (read!=size or pending!=size-restored):
            raise RuntimeError('Resume source/pending counters do not match the complete file')
        if status=='already-committed' and (pending!=0 or read!=0):
            raise RuntimeError('Committed checkpoint caused another data attempt')
        # Node handles are compared in memory; only numeric counters enter artifacts.
        record['resume']={k:output[k] for k in ('status','restoredAcknowledgedBytes','pendingSourceBytes','sourceBytesRead')}
        self.save()
        return output

    def interrupt(self,source,name,state,kind):
        args=[str(self.fork),*self.resume_args(source,name,state),'--bwlimit','2Mi',
              '--retries','1','--low-level-retries','3','--contimeout','20s',
              '--timeout','60s','--mega-use-https=true','--use-json-log','--stats','1s']
        started=time.monotonic()
        process=None
        with tempfile.TemporaryFile() as private_log:
            try:
                process=subprocess.Popen(args,env=self.env,stdout=subprocess.PIPE,stderr=private_log)
                wait_checkpoint_progress(process,state)
                stop_started=time.monotonic()
                if kind=='signal':process.send_signal(signal.SIGINT)
                elif kind=='kill':process.kill()
                else:raise RuntimeError('Unknown interruption type')
                try:
                    process.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    raise RuntimeError('Interrupted CLI did not join before the stop deadline') from None
                stop_seconds=round(time.monotonic()-stop_started,3)
                if process.returncode==0:
                    raise RuntimeError('Interrupted CLI unexpectedly returned success')
                if kind=='signal' and process.returncode!=130:
                    raise RuntimeError('SIGINT did not complete through the CLI exit handler')
                self.report['checks'].append({'label':'interrupt '+name,'kind':kind,
                    'exitCode':process.returncode,'seconds':round(time.monotonic()-started,3),
                    'stopSeconds':stop_seconds,'checkpointReplacementObserved':True,
                    'restoredProgressRequiresSubsequentAuthentication':True})
                self.save()
            finally:
                if process is not None:
                    if process.poll() is None:process.kill()
                    process.communicate(timeout=15)
        if any(entry['Name']==name for entry in self.listing()):
            raise RuntimeError('Interrupted upload published a destination file')

    def require_one_node(self,name):
        if sum(entry['Name']==name for entry in self.listing())!=1:
            raise RuntimeError('Resume left missing or duplicate destination files')

    def run(self):
        with tempfile.TemporaryDirectory(prefix='rfork-resume-auth-') as directory:
            self.login()
            self.configure_private_login(Path(directory)/'rclone.conf')
            self.run_authenticated()

    def run_authenticated(self):
        try:
            self.command(self.fork,['mkdir',self.remote],'create isolated resume folder')
            self.report['settings']={'workers':2,'requestSizeBytes':MIB,'pacing':'10ms',
                'checkpointInterval':'50ms','interruptionBandwidth':'2Mi/s',
                'purpose':'correctness interruption window; no performance ranking'}
            with tempfile.TemporaryDirectory(prefix='rfork-live-resume-') as directory:
                work=Path(directory)
                payload=work/'payload.bin'
                payload.write_bytes(os.urandom(9*MIB+31))
                self.report['payloadSHA256']=base.sha256(payload)
                kinds=['kill'] if self.target=='windows' else ['signal','kill']
                for kind in kinds:
                    name=kind+'.bin'
                    state=work/(kind+'-state')
                    self.interrupt(payload,name,state,kind)
                    # A destination-name change must not silently replace the session.
                    self.command(self.fork,self.resume_args(payload,'wrong-'+name,state),
                                 'reject wrong destination binding '+kind,expected_code=NO_RETRY_EXIT,timeout=120)
                    if kind==kinds[0]:
                        self.fresh_authentication()
                        self.report['freshAuthenticationBeforeResume']=True
                    finished=self.resume(payload,name,state,min_restored=1)
                    self.verify(payload,name,work)
                    self.require_one_node(name)
                    repeated=self.resume(payload,name,state,status='already-committed')
                    same=finished['node']==repeated['node']
                    self.report['checks'].append({'label':'committed identity '+kind,'matches':same})
                    self.save()
                    if not same:raise RuntimeError('Committed checkpoint returned a different node')
                    self.require_one_node(name)
                    self.command(self.fork,self.resume_args(payload,name,work/(kind+'-fresh-state')),
                                 'refuse existing destination '+kind,expected_code=NO_RETRY_EXIT,timeout=120)
                state=work/'changed-state'
                self.interrupt(payload,'changed.bin',state,'kill')
                original=payload.read_bytes()
                info=payload.stat()
                changed=bytearray(original);changed[0]^=1
                payload.write_bytes(changed)
                os.utime(payload,ns=(info.st_atime_ns,info.st_mtime_ns))
                self.command(self.fork,self.resume_args(payload,'changed.bin',state),
                             'reject changed source despite restored metadata',expected_code=NO_RETRY_EXIT,timeout=120)
                if any(entry['Name']=='changed.bin' for entry in self.listing()):
                    raise RuntimeError('Rejected source published a file')
                payload.write_bytes(original)
                self.resume(payload,'changed.bin',state,min_restored=1)
                self.verify(payload,'changed.bin',work)
                self.require_one_node('changed.bin')
                boundary=work/'boundary.bin'
                for size in (0,17,131073):
                    boundary.write_bytes(os.urandom(size))
                    name=f'boundary-{size}.bin'
                    self.resume(boundary,name,work/f'boundary-state-{size}')
                    self.verify(boundary,name,work)
                    self.require_one_node(name)
            self.report['status']='success'
        except BaseException as error:
            self.report['status']='failure'
            self.report['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
            raise
        finally:
            self.save()
            self.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['run','cleanup'])
    parser.add_argument('--target',choices=['linux','windows','darwin'],required=True)
    args=parser.parse_args()
    test=UploadResumeTest(args.target,cleanup_only=args.mode=='cleanup')
    if args.mode=='run':test.run()
    elif test.report and not test.report['cleanup']:
        test.login();test.cleanup()
