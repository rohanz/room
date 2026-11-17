#!/usr/bin/env python3
"""Combine raw runs by scenario ID; focused corrections override earlier runs.
Does not turn comparison disagreements into test passes: summary counts them.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = ['correctness-results.json', 'supplement-results.json', 'staged-results.json',
         'candidate-results.json', 'extra-results.json']


def summarize():
    rows = {}
    for file in FILES:
        if not (ROOT/file).exists(): continue
        for row in json.loads((ROOT/file).read_text()):
            row['evidence'] = file
            rows[row['id']] = row
    values = list(rows.values())
    counts = {'scenarios':len(values), 'event_correct':0, 'head_parent_correct':0, 'main_both_correct':0,
              'event_wrong':[], 'event_fixes_head_parent':[], 'main_mismatches':[]}
    table = ['C = conflict; — = no conflict. Main shows both evaluator directions, '
             'all **run** against `2152836e`. “No conflict” includes absent slots; '
             'raw JSON retains slots and notice counts. This is collision evidence, '
             'not a claim that notice handoff/ownership was validated.', '',
             '| Scenario (archived case mapping) | Expected | HEAD parent | Event graph | Main, both directions |',
             '|---|---|---|---|---|']
    def label(status): return {'conflict':'C','clean':'—'}.get(status,status)
    for i,row in enumerate(values,1):
        want=row['expected']; event=row['native']['status']; bare=row['naive']['status']
        correct=event == want
        counts['event_correct'] += correct
        counts['head_parent_correct'] += bare == want
        main=[m['status'] for m in row['main']]
        counts['main_both_correct'] += all(m == want for m in main)
        if not correct: counts['event_wrong'].append(row['id'])
        if correct and bare != want: counts['event_fixes_head_parent'].append(row['id'])
        if any(m != want for m in main): counts['main_mismatches'].append(row['id'])
        title=f"{i}. {row['id']}<br><small>{row['source']}</small>"
        table.append(f"| {title} | {label(want)} | {label(bare)} | {label(event)}{' **needs rule**' if not correct else ''} | {' / '.join(map(label,main))} |")
    (ROOT/'results.json').write_text(json.dumps(values,indent=2)+'\n')
    (ROOT/'summary.json').write_text(json.dumps(counts,indent=2)+'\n')
    (ROOT/'correctness-table.md').write_text('\n'.join(table)+'\n')
    return counts


if __name__ == '__main__': print(json.dumps(summarize(),indent=2))
