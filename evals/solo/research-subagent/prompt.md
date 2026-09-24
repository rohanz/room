---
description: "Read-only research may use a built-in subagent; it is not Room worker work."
tags: [solo]
plugins: ["../../../plugins/room"]
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Use a subagent to find every place that reads catalog prices, then list them for me.
