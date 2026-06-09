import { Transform, TransformCallback } from 'stream';
import crypto from 'crypto';

/**
 * A pass-through transform stream that calculates the SHA-256 hash of all data passing through it.
 */
export class ChecksumStream extends Transform {
  private hash = crypto.createHash('sha256');

  _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    callback(null, chunk);
  }

  getChecksum(): string {
    // Return hex hash digest
    return this.hash.copy().digest('hex');
  }
}
