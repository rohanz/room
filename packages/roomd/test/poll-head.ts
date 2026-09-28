import type { Roomd } from '../src/index.js'

/** Runs the daemon's HEAD poll through its work queue, as production does, and rethrows its failure. */
export function pollHead(daemon: Roomd): Promise<void> {
  const poll = (daemon as unknown as { pollHead(): Promise<void> }).pollHead.bind(daemon)
  return new Promise((resolve, reject) => { void daemon.enqueue(() => poll().then(resolve, reject)) })
}
