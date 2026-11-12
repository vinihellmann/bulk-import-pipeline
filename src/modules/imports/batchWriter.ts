/**
 * Accumulates items and flushes them in fixed-size batches. If a flush fails the batch is
 * kept in the buffer, so `pending` stays truthful and the caller decides whether to retry.
 */
export class BatchWriter<T> {
  private buffer: T[] = [];

  constructor(
    private readonly flushFn: (items: T[]) => Promise<void>,
    private readonly batchSize: number,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('batchSize must be a positive integer');
    }
  }

  /** Items buffered but not yet durably written. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Adds an item; returns true when this call triggered a flush. */
  async add(item: T): Promise<boolean> {
    this.buffer.push(item);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
      return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.flushFn(batch);
    } catch (err) {
      this.buffer = batch;
      throw err;
    }
  }
}
