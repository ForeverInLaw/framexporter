export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const queue = [...items];
  const workerCount = Math.max(1, Math.min(limit, queue.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const item = queue[cursor];
        cursor += 1;
        if (item === undefined) {
          return;
        }

        await worker(item);
      }
    }),
  );
}