// Tests never write the user's Room config dir (machine-id, credentials, worker port reservations).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

// Claude host identity must not leak into tests or the child processes they spawn.
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete process.env[key]

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-config-'))
process.env.XDG_CONFIG_HOME = configHome
afterAll(() => fs.rmSync(configHome, { recursive: true, force: true }))
