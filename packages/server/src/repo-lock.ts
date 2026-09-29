/** Serializes lifecycle operations for one repository without blocking unrelated repositories. */
export class RepoLocks {
  private readonly tails = new Map<string, Promise<void>>()
  async run<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(repo) ?? Promise.resolve()
    let done!: () => void
    const tail = new Promise<void>(resolve => { done = resolve })
    this.tails.set(repo, tail)
    await before
    try { return await fn() }
    finally { done(); if (this.tails.get(repo) === tail) this.tails.delete(repo) }
  }
}
