import { Readable } from 'node:stream';
import { InvalidFileError } from '../../src/modules/imports/domain/errors';
import { limitStreamBytes } from '../../src/modules/imports/infrastructure/limitStreamBytes';

async function drain(stream: Readable): Promise<number> {
  let n = 0;
  for await (const chunk of stream) n += (chunk as Buffer).length;
  return n;
}

describe('limitStreamBytes', () => {
  it('passes through streams within the limit', async () => {
    const src = Readable.from([Buffer.from('abcd'), Buffer.from('efgh')]);
    await expect(drain(limitStreamBytes(src, 8))).resolves.toBe(8);
  });

  it('fails with InvalidFileError once the limit is exceeded and stops the source', async () => {
    const src = Readable.from([Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('i')]);
    const limited = limitStreamBytes(src, 8);
    const err = await drain(limited).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidFileError);
    expect((err as Error).message).toBe('File exceeds the maximum size of 8 bytes');
    await new Promise((r) => setImmediate(r));
    expect(src.destroyed).toBe(true);
  });

  it('forwards source errors', async () => {
    const src = new Readable({
      read() {
        this.destroy(new Error('socket reset'));
      },
    });
    await expect(drain(limitStreamBytes(src, 8))).rejects.toThrow('socket reset');
  });
});
