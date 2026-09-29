// Tests never write the user's Room config dir (machine-id, credentials, worker port reservations).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

// Host and Room identity must not leak into tests or the child processes they spawn: a suite run inside a
// Claude or Codex session, or inside a Room worker, would otherwise act as that session or worker.
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID']) delete process.env[key]
for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]

delete process.env.CLAUDE_PLUGIN_ROOT

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-config-'))
process.env.XDG_CONFIG_HOME = configHome
// Nor read the user's Codex rollouts and plugin cache, or Claude Code's installed-plugin list.
process.env.CODEX_HOME = path.join(configHome, 'codex')
process.env.CLAUDE_CONFIG_DIR = path.join(configHome, 'claude')
afterAll(() => fs.rmSync(configHome, { recursive: true, force: true }))
