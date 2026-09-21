import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { createRenderScheduler } from './scheduler.ts'

let dom: JSDOM
let scheduler: ReturnType<typeof createRenderScheduler>
let frames: Map<number, FrameRequestCallback>
let next: number
beforeEach(() => {
  dom = new JSDOM('', { pretendToBeVisual: true })
  vi.stubGlobal('document', dom.window.document)
  vi.useFakeTimers()
  frames = new Map(); next = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((fn: FrameRequestCallback) => { frames.set(++next, fn); return next }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  scheduler = createRenderScheduler()
})
afterEach(() => { scheduler.dispose(); dom.window.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const visible = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new dom.window.Event('visibilitychange'))
}
it('coalesces 100 schedules per key into the latest callbacks in one frame', () => {
  const old = vi.fn(), latest = vi.fn(), other = vi.fn()
  for (let i = 0; i < 100; i++) { scheduler.schedule('code', i === 99 ? latest : old); scheduler.schedule('people', other) }
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  expect(latest).not.toHaveBeenCalled()
  frames.values().next().value!(0)
  expect(old).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1); expect(other).toHaveBeenCalledTimes(1)
  expect(frames.size).toBe(0)
})
it('switches pending frames to a 1000ms hidden timer and flushes immediately on visible', () => {
  const render = vi.fn()
  scheduler.schedule('code', render)
  visible(true)
  expect(frames.size).toBe(0)
  vi.advanceTimersByTime(999); expect(render).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(render).toHaveBeenCalledTimes(1)
  scheduler.schedule('code', render)
  visible(false)
  expect(render).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1000); expect(render).toHaveBeenCalledTimes(2)
})
it('isolates failures and logs only once per failing key', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const render = vi.fn()
  for (let i = 0; i < 2; i++) {
    scheduler.schedule('broken', () => { throw new Error('broken') })
    scheduler.schedule('ok', render)
    scheduler.flushNow()
  }
  expect(error).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledTimes(2)
})
it('defers reentrant work to the next batch and cancels everything on disposal', () => {
  const later = vi.fn()
  scheduler.schedule('code', () => scheduler.schedule('code', later))
  scheduler.flushNow()
  expect(later).not.toHaveBeenCalled(); expect(frames.size).toBe(1)
  scheduler.dispose()
  scheduler.schedule('code', later)
  scheduler.flushNow(); visible(false)
  expect(frames.size).toBe(0); expect(later).not.toHaveBeenCalled()
})
