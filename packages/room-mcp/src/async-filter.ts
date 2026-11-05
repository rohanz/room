/** Resolve predicates before filtering; promises themselves are always truthy. */
export async function asyncFilter<T>(items: readonly T[], keep: (item: T) => boolean | Promise<boolean>): Promise<T[]> {
  const accepted = await Promise.all(items.map(keep))
  return items.filter((_, index) => accepted[index])
}
