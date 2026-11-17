import { afterEach,expect,it,vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
const budget=(ConflictShadow.prototype as any).budget
function context(){
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  vi.spyOn(performance,'now').mockReturnValue(1000)
  const cancellation=new AbortController()
  return {graph:{deadline:11000},cancellation,closed:false,halt:vi.fn(),stop:vi.fn()}
}
it('ends a hung private pass at the injected deadline without waiting for its work',async()=>{
  const state=context();let settled=false
  const work=new Promise(()=>{}).finally(()=>{settled=true})
  const result=budget.call(state,()=>work).catch((error:Error)=>error)
  await vi.advanceTimersByTimeAsync(10000)
  expect((await result).message).toMatch(/over budget/)
  expect(settled).toBe(false);expect(state.stop).toHaveBeenCalledTimes(1)
  expect(state.halt).toHaveBeenCalledWith('over budget: private pass deadline exceeded')
  expect(vi.getTimerCount()).toBe(0)
})
it('cancels a private pass independently of its injected clock',async()=>{
  const state=context(),result=budget.call(state,()=>new Promise(()=>{})).catch((error:Error)=>error)
  state.cancellation.abort()
  expect((await result).message).toBe('shadow stopped')
  expect(state.halt).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
})
it('bounds cleanup with the injected timer without recursively stopping',async()=>{
  const state=context(),result=budget.call(state,()=>new Promise(()=>{}),true).catch((error:Error)=>error)
  await vi.advanceTimersByTimeAsync(10000)
  expect((await result).message).toMatch(/over budget/)
  expect(state.stop).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
})
