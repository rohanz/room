import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('does not pass Claude session identity into tests or their child processes', () => {
  const keys = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
  for (const key of keys) expect(process.env[key]).toBeUndefined()
  const inherited = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE")))'], { encoding: 'utf8' })) as string[]
  for (const key of keys) expect(inherited).not.toContain(key)
})
