#!/usr/bin/env python3
"""Throwaway Git plumbing measurements. Only reads this checkout; removes fixtures.

Run from the repository root: python3 docs/archive/reports/2026-11-17-git-native/measure.py
No Room filtering is implemented: these are Git-only lower-bound measurements.
"""
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

ENV = dict(os.environ, GIT_AUTHOR_NAME='Room study', GIT_AUTHOR_EMAIL='study@example.test',
           GIT_COMMITTER_NAME='Room study', GIT_COMMITTER_EMAIL='study@example.test',
           GIT_CONFIG_NOSYSTEM='1')
ENV.pop('GIT_INDEX_FILE', None)
ROOT = Path.cwd()
BASE = '2152836ea8b5361ba631c81d4240c543224348a9'
REPEATS = 5
BLOB_CACHE = {}


def git(d, *args, env=None, data=None, check=True):
    p = subprocess.run(['git', '-C', str(d), '-c', 'commit.gpgsign=false', *args],
                       input=data, env=env or ENV, capture_output=True)
    if check and p.returncode:
        raise RuntimeError((args, p.returncode, p.stderr.decode()))
    return p


def out(d, *args, **kw):
    return git(d, *args, **kw).stdout.decode().strip()


def timed(f):
    samples = []
    for _ in range(REPEATS):
        start = time.perf_counter(); f(); samples.append((time.perf_counter()-start)*1000)
    return {'median_ms': round(statistics.median(samples), 3), 'samples_ms': [round(x, 3) for x in samples]}


def snapshot(d, index, parent, first=False):
    env = dict(ENV, GIT_INDEX_FILE=str(index))
    if first: git(d, 'read-tree', parent, env=env)
    git(d, 'add', '-A', '--', '.', env=env)
    tree = out(d, 'write-tree', env=env)
    return out(d, 'commit-tree', tree, '-p', parent, '-m', 'private observation', env=env)


def tree_commit(d, base, edits, index):
    env = dict(ENV, GIT_INDEX_FILE=str(index))
    git(d, 'read-tree', base, env=env)
    records = b''
    for name, value, mode in edits:
        key = (str(d), value)
        if key not in BLOB_CACHE: BLOB_CACHE[key] = out(d, 'hash-object', '-w', '--stdin', data=value)
        oid = BLOB_CACHE[key]
        records += f'{mode} {oid}\t{name}\0'.encode()
    git(d, 'update-index', '-z', '--index-info', env=env, data=records)
    return out(d, 'commit-tree', out(d, 'write-tree', env=env), '-p', base, '-m', 'fixture')


def measure(d, scratch):
    base = out(d, 'rev-parse', 'HEAD')
    counter = 0
    def first():
        nonlocal counter
        counter += 1
        snapshot(d, scratch/f'first-{counter}', base, True)
    results = {'tracked_files': len(git(d, 'ls-files', '-z').stdout.split(b'\0'))-1,
               'first_snapshot': timed(first)}
    idx = scratch/'reuse'
    snapshot(d, idx, base, True)
    counter = 0
    def changed():
        nonlocal counter
        counter += 1; (d/'study-one.txt').write_text(f'edit {counter}\n')
        snapshot(d, idx, base)
    results['one_file_snapshot_index_reused'] = timed(changed)
    results['pairs'] = {}
    pairs = {}
    for n in [0, 10, 200, 4000]:
        a = tree_commit(d, base, [(f'pair/p{i}.txt', b'ours\n', '100644') for i in range(n)], scratch/'a')
        b = tree_commit(d, base, [(f'pair/p{i}.txt', b'theirs\n', '100644') for i in range(n)], scratch/'b')
        pairs[n] = (a, b)
        def merge():
            p = git(d, 'merge-tree', '--write-tree', a, b, check=False)
            assert p.returncode == (1 if n else 0), p.stderr
        results['pairs'][n] = timed(merge)
        if n in [10, 200]:
            c = tree_commit(d, base, [(f'other/p{i}.txt', b'theirs\n', '100644') for i in range(n)], scratch/'c')
            results.setdefault('clean_disjoint_pairs', {})[n] = timed(lambda: git(d, 'merge-tree', '--write-tree', a, c))
    # Full family pass: seven real directories, each a linked worktree in this
    # temporary fixture, independent private indexes, serial bounded commands.
    members = []
    for i in range(7):
        member = scratch/f'member-{i}'
        git(d, 'worktree', 'add', '--detach', str(member), base)
        members.append(member)
        snapshot(member, scratch/f'idx-{i}', base, True)
    generation = 0
    def family(cached, deduplicate=False):
        nonlocal generation
        generation += 1
        (members[1]/'study-family.txt').write_text(f'worker edit {generation}\n')
        commits = [base]*7
        for i in ([1] if cached else range(7)):
            commits[i] = snapshot(members[i], scratch/f'idx-{i}', base)
        seen=set()
        for i in range(7):
            for j in range(i+1, 7):
                if cached and i != 1 and j != 1: continue
                key=tuple(sorted([commits[i],commits[j]]))
                if deduplicate and key in seen: continue
                seen.add(key)
                assert git(d, 'merge-tree', '--write-tree', commits[i], commits[j], check=False).returncode == 0
    results['family_uncached_7_snapshots_21_merges'] = timed(lambda: family(False))
    results['family_dirty_cached_1_snapshot_6_merges'] = timed(lambda: family(True))
    results['family_identical_peers_1_snapshot_1_merge'] = timed(lambda: family(True, True))
    results['git_objects_kib_after_fixture'] = out(d, 'count-objects', '-v')
    return results


def output_cases(d, scratch):
    (d/'f.txt').write_text('one\nbase\nthree\n')
    (d/'binary.dat').write_bytes(b'\0base')
    (d/'old.txt').write_text('rename me\n'*20)
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'case base')
    base = out(d, 'rev-parse', 'HEAD')
    cases = {
        'content': ([('f.txt', b'one\nours\nthree\n', '100644')], [('f.txt', b'one\ntheirs\nthree\n', '100644')]),
        'add_add': ([('new.txt', b'ours\n', '100644')], [('new.txt', b'theirs\n', '100644')]),
        'binary': ([('binary.dat', b'\0ours', '100644')], [('binary.dat', b'\0theirs', '100644')]),
        'mode_content': ([('f.txt', b'one\nbase\nthree\n', '100755')], [('f.txt', b'one\ntheirs\nthree\n', '100644')]),
        'type_change': ([('f.txt', b'target', '120000')], [('f.txt', b'one\ntheirs\nthree\n', '100644')]),
        'large_8mib': ([('large.txt', b'a\n'*(4*1024*1024), '100644')], [('large.txt', b'b\n'*(4*1024*1024), '100644')]),
    }
    result = {}
    for name, (ae, be) in cases.items():
        a = tree_commit(d, base, ae, scratch/'ca'); b = tree_commit(d, base, be, scratch/'cb')
        p = git(d, 'merge-tree', '--write-tree', a, b, check=False)
        result[name] = {'code': p.returncode, 'stdout': p.stdout.decode(), 'stderr': p.stderr.decode(),
                        'timing': timed(lambda: git(d, 'merge-tree', '--write-tree', a, b, check=False))}
        if name == 'mode_content':
            merged_tree=p.stdout.decode().splitlines()[0]
            result[name]['merged_entry']=out(d,'ls-tree',merged_tree,'--','f.txt')
            result[name]['merged_content']=out(d,'show',f'{merged_tree}:f.txt')
        if name == 'content':
            result[name]['structured_stdout']=git(d,'merge-tree','--write-tree','-z',a,b,check=False).stdout.decode()
            merged_tree = p.stdout.decode().splitlines()[0]
            result[name]['read_merged_blob'] = timed(lambda: git(d, 'show', f'{merged_tree}:f.txt'))
            # Existing Room line semantics come from merge-file --diff3. Include
            # fetching all three inputs and writing/removing temporary files.
            def lines():
                with tempfile.TemporaryDirectory(dir=scratch) as td:
                    paths=[]
                    for label, commit in [('base',base),('ours',a),('theirs',b)]:
                        file=Path(td)/label; file.write_bytes(git(d,'show',f'{commit}:f.txt').stdout); paths.append(str(file))
                    q=git(d,'merge-file','-p','--diff3',paths[1],paths[0],paths[2],check=False)
                    assert q.returncode == 1
                    assert b'<<<<<<<' in q.stdout
            result[name]['recover_lines_three_shows_and_merge_file'] = timed(lines)
    def branch(edits, deletes):
        env = dict(ENV, GIT_INDEX_FILE=str(scratch/'special'))
        a = tree_commit(d, base, edits, scratch/'special')
        for name in deletes: git(d, 'update-index', '--force-remove', '--', name, env=env)
        return out(d, 'commit-tree', out(d, 'write-tree', env=env), '-p', base, '-m', 'case')
    content = tree_commit(d, base, [('f.txt', b'one\ntheirs\nthree\n', '100644')], scratch/'ct')
    for name, a, b in [
        ('modify_delete', branch([], ['f.txt']), content),
        ('rename_rename', branch([('new-a.txt', b'rename me\n'*20, '100644')], ['old.txt']), branch([('new-b.txt', b'rename me\n'*20, '100644')], ['old.txt'])),
        ('rename_modify', branch([('renamed.txt', b'rename me\n'*20, '100644')], ['old.txt']), branch([('old.txt', b'rename me\n'*19+b'changed\n', '100644')], [])),
    ]:
        p = git(d, 'merge-tree', '--write-tree', a, b, check=False)
        result[name] = {'code': p.returncode, 'stdout': p.stdout.decode(), 'stderr': p.stderr.decode()}
    return result


def count_paths(root):
    """Separate one-base-file fixture: verify the path list is not truncated."""
    d=root/'repo'; d.mkdir(); git(d,'init','-q')
    (d/'base.txt').write_text('base\n'); git(d,'add','-A'); git(d,'commit','-qm','base')
    base=out(d,'rev-parse','HEAD')
    a=tree_commit(d,base,[(f'pair/p{i}.txt',b'ours\n','100644') for i in range(4000)],root/'a')
    b=tree_commit(d,base,[(f'pair/p{i}.txt',b'theirs\n','100644') for i in range(4000)],root/'b')
    result=git(d,'merge-tree','--write-tree','--name-only','-z',a,b,check=False)
    paths=[]
    for item in result.stdout.split(b'\0')[1:]:
        if not item: break
        paths.append(item)
    assert result.returncode==1 and len(paths)==len(set(paths))==4000
    return {'method':'separate generated one-base-file repository, 4000 add/add paths; --name-only -z',
            'code':result.returncode,'conflicted_paths':len(paths),'stdout_bytes':len(result.stdout),
            'unique':len(set(paths)),'temporary_fixture_removed':True}


def main():
    result = {'git': out(ROOT, '--version'), 'baseline': BASE, 'repeats': REPEATS,
              'method': 'serial subprocesses; warm filesystem/object cache; private indexes; Git filtering only'}
    with tempfile.TemporaryDirectory(prefix='room-git-native-measure-') as tmp:
        tmp = Path(tmp)
        repo = tmp/'repo'; repo.mkdir()
        archive = git(ROOT, 'archive', BASE).stdout
        subprocess.run(['tar', '-xf', '-', '-C', str(repo)], input=archive, check=True)
        # Initialize standalone object storage: never write this checkout's .git.
        git(repo, 'init', '-q'); git(repo, 'add', '-f', '-A'); git(repo, 'commit', '-qm', 'repository fixture')
        scratch = tmp/'small'; scratch.mkdir()
        result['repository'] = measure(repo, scratch)
        big = tmp/'large'; big.mkdir(); git(big, 'init', '-q')
        for i in range(20000):
            file = big/f'd{i//200:03}'/f'f{i:05}.txt'; file.parent.mkdir(exist_ok=True)
            file.write_text(f'file {i}\n' + 'unchanged line\n'*10)
        git(big, 'add', '-A'); git(big, 'commit', '-qm', '20000 generated files')
        bs = tmp/'big-scratch'; bs.mkdir()
        result['generated_20000'] = measure(big, bs)
        cs = tmp/'cases'; cs.mkdir()
        result['output_cases'] = output_cases(repo, cs)
        count=tmp/'count'; count.mkdir()
        result['thousands_output_probe']=count_paths(count)
    print(json.dumps(result, indent=2))


if __name__ == '__main__': main()
