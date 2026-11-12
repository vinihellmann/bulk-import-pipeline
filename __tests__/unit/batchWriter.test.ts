import { BatchWriter } from '../../src/modules/imports/application/batchWriter';

describe('BatchWriter', () => {
  it('flushes full batches automatically and the remainder on demand', async () => {
    const flushed: number[][] = [];
    const writer = new BatchWriter<number>(async (items) => {
      flushed.push(items);
    }, 3);

    const triggered: boolean[] = [];
    for (let i = 1; i <= 7; i++) triggered.push(await writer.add(i));

    expect(flushed).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(triggered).toEqual([false, false, true, false, false, true, false]);
    expect(writer.pending).toBe(1);

    await writer.flush();
    expect(flushed).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(writer.pending).toBe(0);
  });

  it('does not call the sink for an empty flush', async () => {
    const sink = jest.fn(async () => undefined);
    await new BatchWriter<number>(sink, 2).flush();
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps the batch buffered when the sink fails, so a retry writes it', async () => {
    let fail = true;
    const written: string[][] = [];
    const writer = new BatchWriter<string>(async (items) => {
      if (fail) throw new Error('deadlock');
      written.push(items);
    }, 2);

    await writer.add('a');
    await expect(writer.add('b')).rejects.toThrow('deadlock');
    expect(writer.pending).toBe(2);

    fail = false;
    await writer.flush();
    expect(written).toEqual([['a', 'b']]);
    expect(writer.pending).toBe(0);
  });

  it.each([0, -1, 1.5])('rejects invalid batch size %p', (size) => {
    expect(() => new BatchWriter(async () => undefined, size)).toThrow(RangeError);
  });
});
