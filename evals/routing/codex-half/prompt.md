---
description: "A split between this session and Codex goes to room_spawn with host codex, not a built-in subagent."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

The README lists three tickets. Get codex to do half of this while you do the rest.
