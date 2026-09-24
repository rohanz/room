---
type: regex
target: trace
pattern: '"type":"tool_use","id":"[^"]+","name":"(Task|Agent)"'
match: not_contains
---
