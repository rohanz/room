import { expect, it } from 'vitest'
import { sessionHostIdentity } from '../../src/hosts/session-host.js'
const host = { pid: 2, startTime: 's', executable: 'node' }
it.each(['node', '2.1.318', 'claude', 'anything'])('selects the first host regardless of name: %s', executable => {
  expect(sessionHostIdentity({ chain: [{ ...host, executable }, { ...host, pid: 3 }] })).toEqual({ ...host, executable })
})
it.each(['sh', 'bash', 'dash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'CMD.EXE', 'pwsh.exe'])('skips one interpreter: %s', executable => {
  expect(sessionHostIdentity({ chain: [{ ...host, pid: 1, executable }, host] })).toEqual(host)
})
it('falls back only without a chain and fails closed on malformed chains', () => {
  expect(sessionHostIdentity({ hostPid: 9 })).toEqual({ pid: 9, startTime: '', executable: '' })
  for (const chain of [[], 'invalid', null, [{}], [null, host], [{ ...host, executable: 'sh' }]]) {
    expect(sessionHostIdentity({ hostPid: 9, chain })).toBeUndefined()
  }
})

it('does not take a second hook interpreter for the host', () => {
  const chain = [{ pid: 1, startTime: 'a', executable: 'sh' }, { pid: 2, startTime: 'b', executable: 'zsh' }, { pid: 3, startTime: 'c', executable: 'claude' }]
  expect(sessionHostIdentity({ host: 'claude', hostPid: 3, chain })).toBeUndefined()
  expect(sessionHostIdentity({ host: 'claude', chain: chain.slice(1) })).toEqual(chain[2])
})
