---
type: llm
---

PASS if the assistant dispatches at least two independent handler tickets through Room and does not refuse parallel work merely because both agents will touch api/handlers.py. A lead doing the third ticket itself is fine.
FAIL if it says shared file paths prevent parallel work, leaves the tasks sequential for that reason, or uses built-in subagents instead of Room workers.
