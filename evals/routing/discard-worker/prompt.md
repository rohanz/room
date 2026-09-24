---
description: "Throwing a worker away is room_collect with discard=true on that tag, not a hand revert."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

The pricing-fix worker went the wrong way. Throw that worker away.
