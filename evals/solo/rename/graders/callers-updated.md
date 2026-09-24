---
type: regex
target: { source: file, path: tests/test_pricing.py }
pattern: '\bsubtotal\('
match: not_contains
---
