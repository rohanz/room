---
description: "A small solo edit makes zero Room calls and leaves the rename in place."
tags: [solo]
plugins: ["../../../plugins/room"]
max_turns: 20
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Rename subtotal in api/pricing.py to lines_subtotal and update every caller, including the tests.
