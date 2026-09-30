---
description: "Dependent changes on the same symbol stay with one agent."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 24
timeout_seconds: 480
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Rename `charge_total` to `payment_total` everywhere, and also change its signature to accept a `discount` parameter. Both changes affect the same function in api/handlers.py. Handle this as one coordinated task.
