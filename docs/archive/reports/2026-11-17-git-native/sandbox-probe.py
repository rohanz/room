#!/usr/bin/env python3
"""Run un-escalated in the worker. No refs, branch, real index or files changed.
Successful shared-store writes, on a less restricted host, leave unreachable objects.
"""
import json
import os
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='room-native-probe-') as scratch:
    env = dict(os.environ, GIT_INDEX_FILE=scratch+'/index',
               GIT_AUTHOR_NAME='Room study', GIT_AUTHOR_EMAIL='study@example.test',
               GIT_COMMITTER_NAME='Room study', GIT_COMMITTER_EMAIL='study@example.test')
    def run(args, data=None):
        p = subprocess.run(['git', *args], env=env, input=data, capture_output=True)
        print(json.dumps({'args':args, 'code':p.returncode,
                          'stdout':p.stdout.decode(), 'stderr':p.stderr.decode()}))
        return p.stdout.decode().strip()
    run(['rev-parse','--git-common-dir'])
    run(['hash-object','-w','--stdin'], b'Room git-native sandbox probe 2026-11-17\n')
    run(['read-tree','HEAD'])
    run(['write-tree'])
    blob = subprocess.check_output(['git','rev-parse','HEAD:README.md'],text=True).strip()
    run(['update-index','--add','--cacheinfo',f'100644,{blob},room-native-unique-probe.txt'])
    run(['write-tree'])
    run(['commit-tree','HEAD^{tree}','-p','HEAD','-m','Room study unreferenced probe'])
    # Same worktree and sandbox, private writable objects + read-only alternate.
    common = subprocess.check_output(['git','rev-parse','--git-common-dir'],text=True).strip()
    os.mkdir(scratch+'/objects')
    env.update(GIT_OBJECT_DIRECTORY=scratch+'/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES=os.path.abspath(common)+'/objects')
    run(['hash-object','-w','--stdin'], b'Room git-native private object store\n')
    tree = run(['write-tree'])
    run(['commit-tree',tree,'-p','HEAD','-m','Room study private store probe'])
