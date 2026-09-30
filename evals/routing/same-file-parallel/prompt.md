---
description: "Three independent tasks in one file still dispatch in parallel through Room."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 24
timeout_seconds: 480
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

The three same-file handler tickets in the README all touch api/handlers.py. Do them in parallel with agents; I want to keep talking to you while they run.
