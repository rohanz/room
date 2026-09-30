---
description: "Route a natural request to the right Room tool."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Ask the worker a follow-up: also handle refunds.
