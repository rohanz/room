// Tests never write the user's Room config dir (machine-id, credentials, worker port reservations).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-config-'))
process.env.XDG_CONFIG_HOME = configHome
afterAll(() => fs.rmSync(configHome, { recursive: true, force: true }))
