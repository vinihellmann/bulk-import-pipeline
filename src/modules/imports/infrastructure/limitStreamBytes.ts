import { Transform, type Readable } from 'node:stream';
import { InvalidFileError } from '../domain/errors';

/**
 * Wraps `source` so it errors with InvalidFileError as soon as more than `maxBytes` flow
 * through, instead of letting a lying (or tampered) upload feed the parser indefinitely.
 * Destroying the returned stream destroys the source, and source errors are forwarded.
 */
export function limitStreamBytes(source: Readable, maxBytes: number): Readable {
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new InvalidFileError(`File exceeds the maximum size of ${maxBytes} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });
  source.on('error', (err) => limiter.destroy(err));
  limiter.on('close', () => source.destroy());
  source.pipe(limiter);
  return limiter;
}
