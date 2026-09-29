import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const server = fileURLToPath(new URL('../src/index.ts', import.meta.url))

/** Run the server in the spawned process itself so crash signals reach the server. */
export function devServers() {
  const children = new Set<ChildProcess>()

  function start(options: SpawnOptions): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', server], options)
    children.add(child)
    return child
  }

  async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => { if (timer) clearTimeout(timer); resolve() }
      child.once('exit', done)
      child.once('error', done)
      if (child.exitCode !== null || child.signalCode !== null) { done(); return }
      child.kill(signal)
      if (signal !== 'SIGKILL') timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    })
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...children].map(child => stop(child)))
    children.clear()
  }

  return { start, stop, stopAll }
}
