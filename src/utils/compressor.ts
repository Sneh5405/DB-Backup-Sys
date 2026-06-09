import zlib from 'zlib';
import { PassThrough, Transform } from 'stream';

/**
 * Creates a stream transform for compression.
 * If type is 'gzip', returns a Gzip transform stream.
 * If type is 'none', returns a PassThrough stream (no compression).
 */
export function createCompressStream(type: 'gzip' | 'none'): Transform {
  if (type === 'gzip') {
    return zlib.createGzip();
  }
  return new PassThrough();
}

/**
 * Creates a stream transform for decompression.
 * If type is 'gzip', returns a Gunzip transform stream.
 * If type is 'none', returns a PassThrough stream.
 */
export function createDecompressStream(type: 'gzip' | 'none'): Transform {
  if (type === 'gzip') {
    return zlib.createGunzip();
  }
  return new PassThrough();
}
