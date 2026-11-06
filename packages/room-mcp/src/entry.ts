#!/usr/bin/env node
import { bootstrap } from '@room/local-state/bootstrap'

// The MCP preflight is runtime-only (executable, Node, vendor, SQLite): MCPs never open the repository database.
// The per-clone daemon and the offline command own the filesystem/journal preflight and its evidence.
await bootstrap('mcp', async () => { await import('./index.js') })
