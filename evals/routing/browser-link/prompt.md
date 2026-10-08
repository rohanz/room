---
description: "Route browser opening separately from link-only requests."
tags: [routing]
plugins: ["../../../plugins/room"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, TodoWrite]
---

Give me the link to view this Room. I want to click or copy it myself; do not open a browser.
