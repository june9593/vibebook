/**
 * Map `items` through `worker` with at most `limit` workers running at once.
 * Returns results in the SAME order as input. Throws on first worker error
 * and stops dispatching new tasks (in-flight tasks complete naturally; their
 * results are discarded).
 *
 * Pattern: fixed-size pool of workers, each pulling the next index from a
 * shared cursor. No external deps.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  let cursor = 0;
  let aborted = false;
  let abortError: unknown;

  async function pumpOne(): Promise<void> {
    while (!aborted) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!, i);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          abortError = err;
        }
        return;
      }
    }
  }

  const poolSize = Math.min(limit, items.length);
  const pool = Array.from({ length: poolSize }, () => pumpOne());
  await Promise.all(pool);

  if (aborted) throw abortError;
  return results;
}
