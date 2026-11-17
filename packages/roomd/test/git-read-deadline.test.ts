import { performance } from 'node:perf_hooks'
import { afterEach, expect,it,vi } from 'vitest'
import { git,timeoutMs,withGitReadDeadline } from '../src/git.js'

afterEach(() => vi.restoreAllMocks())

it('bounds only the observational async chain, using integer timeout values',async()=>{
  let clock=1000
  vi.spyOn(performance,'now').mockImplementation(()=>clock)
  const normal=timeoutMs()
  await withGitReadDeadline(1040,async()=>{
    expect(Number.isInteger(timeoutMs())).toBe(true)
    expect(timeoutMs()).toBeLessThanOrEqual(40)
    clock=1050
    expect(timeoutMs()).toBe(1)
  })
  expect(timeoutMs()).toBe(normal)
})
it('cancels a source read when its owning shadow leaves',async()=>{
  const cancel=new AbortController();cancel.abort()
  await expect(withGitReadDeadline(performance.now()+1000,()=>git(process.cwd(),['--version']),cancel.signal)).rejects.toThrow()
  expect(await git(process.cwd(),['--version'])).toMatch(/^git version /)
})
