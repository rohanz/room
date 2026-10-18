export class HttpFailure extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Node accepts some request targets that URL rejects. Parse once before routing or authentication. */
export function safeUrl(target: string | undefined): URL {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\x00-\x1f\x7f]/.test(target)) throw new HttpFailure(400, 'Bad Request')
  try { return new URL(target, 'http://x') } catch { throw new HttpFailure(400, 'Bad Request') }
}
