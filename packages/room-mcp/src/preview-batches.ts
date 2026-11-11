/** Whole-tree CPU work yields too: filesystem awaits alone do not bound JS turns. */
export function batchBudget(signal?: AbortSignal): () => Promise<void> | undefined {
  let since = performance.now(), count = 0
  return () => {
    signal?.throwIfAborted()
    if (++count < 1024 && performance.now() - since < 8) return
    count = 0
    return new Promise<void>(resolve => setImmediate(resolve)).then(() => { signal?.throwIfAborted(); since = performance.now() })
  }
}

/** Bottom-up merge sort; no native whole-array sort, Set construction or spread. */
export async function sortedCopy<T>(input: readonly T[], compare: (a: T, b: T) => number, signal?: AbortSignal): Promise<T[]> {
  const budget = batchBudget(signal)
  let source: T[] = [], target: T[] = []
  for (let i = 0; i < input.length; i++) { source.push(input[i]!); const wait = budget(); if (wait) await wait }
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length)
      let left = start, right = middle
      for (let out = start; out < end; out++) {
        target[out] = right >= end || left < middle && compare(source[left]!, source[right]!) <= 0 ? source[left++]! : source[right++]!
        const wait = budget(); if (wait) await wait
      }
    }
    const swap = source; source = target; target = swap
  }
  return source
}
const comparePaths = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export async function normalizedPaths(text: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [], budget = batchBudget(signal)
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\0', start), next = end < 0 ? text.length : end
    if (next > start) paths.push(text.slice(start, next))
    start = next + 1
    const wait = budget(); if (wait) await wait
  }
  const sorted = await sortedCopy(paths, comparePaths, signal), unique: string[] = []
  let previous: string | undefined
  for (const file of sorted) {
    if (file !== previous) unique.push(file)
    previous = file
    const wait = budget(); if (wait) await wait
  }
  return unique
}

/** Incremental bounded encoding, including strings, before any whole-record copy. */
export async function boundedJson(value: unknown, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const budget = batchBudget(signal), chunks: Buffer[] = []
  let bytes = 0, chunk = ''
  const append = (text: string) => {
    bytes += Buffer.byteLength(text)
    if (bytes > maxBytes) throw new Error('preview evidence exceeds 8 MiB; validate the collected tree')
    chunk += text
    if (chunk.length >= 16_384) { chunks.push(Buffer.from(chunk)); chunk = '' }
  }
  const encode = async (item: unknown): Promise<void> => {
    if (typeof item === 'string') {
      append('"')
      for (let start = 0; start < item.length;) {
        let end = Math.min(item.length, start + 4096)
        if (end < item.length && /[\uD800-\uDBFF]/.test(item[end - 1]!)) end++
        append(JSON.stringify(item.slice(start, end)).slice(1, -1)); start = end
        const wait = budget(); if (wait) await wait
      }
      append('"')
    } else if (Array.isArray(item)) {
      append('[')
      for (let i = 0; i < item.length; i++) { if (i) append(','); await encode(item[i]) }
      append(']')
    } else if (item !== null && typeof item === 'object') {
      append('{'); let first = true
      for (const key of Object.keys(item)) {
        const entry = (item as Record<string, unknown>)[key]
        if (entry === undefined) continue
        if (!first) append(','); first = false
        await encode(key); append(':'); await encode(entry)
      }
      append('}')
    } else append(JSON.stringify(item) ?? 'null')
    const wait = budget(); if (wait) await wait
  }
  await encode(value)
  if (chunk) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks, bytes) // Fixed 8 MiB maximum, independent of rejected input size.
}
