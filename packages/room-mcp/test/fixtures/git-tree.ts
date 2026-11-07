import { execFileSync } from 'node:child_process'

/** Build a committed tree without thousands of worktree writes or loose objects.
 * Callers that inject file reads only need Git paths; checkout is deliberately separate.
 */
export function gitTree(dir: string, files: Iterable<readonly [string, string]>): string {
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  const blobs = new Map<string, number>(), entries: string[] = [], stream: string[] = []
  for (const [path, text] of files) {
    let mark = blobs.get(text)
    if (!mark) {
      mark = blobs.size + 1
      blobs.set(text, mark)
      stream.push(`blob\nmark :${mark}\ndata ${Buffer.byteLength(text)}\n${text}\n`)
    }
    entries.push(`M 100644 :${mark} ${JSON.stringify(path)}\n`)
  }
  stream.push('commit refs/heads/main\ncommitter Fixture <fixture@example.test> 1700000000 +0000\ndata 7\nfixture\n', ...entries, '\ndone\n')
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: stream.join(''), stdio: ['pipe', 'pipe', 'pipe'] })
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}
