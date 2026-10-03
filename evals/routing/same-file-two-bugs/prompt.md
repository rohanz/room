---
description: "Two independent bugs in one file can be fixed concurrently."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 24
timeout_seconds: 480
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Use Room workers for this. Fix the coupons and refunds bugs described in the README at the same time. They are both in api/handlers.py. Use another agent for one of them while you do the other.
