#!/usr/bin/env node
import { bootstrap } from '@room/local-state/bootstrap'

// No clone is known here. Registration performs the per-clone filesystem preflight.
await bootstrap('mcp', async () => { await import('./index.js') })
