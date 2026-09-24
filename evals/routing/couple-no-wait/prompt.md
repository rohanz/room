---
description: "Two workers dispatched and left running: room_spawn twice, no blocking wait or collect."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 20
timeout_seconds: 400
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Hand the tiers and shipping-zones tickets from the README to a couple of agents and don't wait for them. I want to keep talking to you.
