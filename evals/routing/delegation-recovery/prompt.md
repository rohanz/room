---
description: "Measure recovery for an explicitly requested Room worker with coherent failed-worker state."
tags: [routing, delegation-diagnostic]
plugins: ["../../../plugins/room"]
max_turns: 16
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

We used Room to delegate the Money ticket to Codex worker money. It stopped because its test command was unavailable. Check its state, then ask that same worker to continue with the correct command from the README. Keep my tiers and shipping work here; do not duplicate the Money implementation.
