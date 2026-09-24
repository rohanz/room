import net from 'node:net'

/** Test-only listener probes. Production relay decisions use authenticated health. */
export function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

export async function relayAnswers(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok && (await response.json()).local === true
  } catch { return false }
}
