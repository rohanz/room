#!/usr/bin/env python3
"""Fast document/data consistency checks, not a production regression suite."""
import ast
import json
from pathlib import Path
import statistics

root=Path(__file__).resolve().parent
for file in root.glob('*.py'): ast.parse(file.read_text(),filename=str(file))
rows=json.loads((root/'results.json').read_text())
summary=json.loads((root/'summary.json').read_text())
assert len(rows)==len({r['id'] for r in rows})==summary['scenarios']
assert sum(r['expected']==r['native']['status'] for r in rows)==summary['event_correct']
assert sum(all(m['status']==r['expected'] for m in r['main']) for r in rows)==summary['main_both_correct']
assert summary['event_wrong']==['supplement: scratch skipped, lead later adds competing log']
measure=json.loads((root/'measurements.json').read_text())
assert measure['repository']['tracked_files']==1492
assert measure['generated_20000']['tracked_files']==20000
def visit(obj):
    if isinstance(obj,dict):
        if 'samples_ms' in obj:
            assert len(obj['samples_ms'])==5
            assert abs(statistics.median(obj['samples_ms'])-obj['median_ms'])<0.002
        for value in obj.values(): visit(value)
    elif isinstance(obj,list):
        for value in obj: visit(value)
visit(measure)
report=(root.parent/'2026-11-17-git-native.md').read_text()
assert 'MEASURED_' not in report
for row in rows: assert row['id'] in report,row['id']
assert not any(root.rglob('__pycache__'))
print(f"Validated {len(rows)} scenarios, timing medians, Python syntax and report coverage")
