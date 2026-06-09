import crypto from 'crypto';
import { Transform, TransformCallback } from 'stream';

/**
 * Derives a 32-byte key from a string passphrase.
 */
export function deriveKey(passphrase: string): Buffer {
  return crypto.createHash('sha256').update(passphrase).digest();
}

/**
 * Encrypts a stream using AES-256-GCM.
 * Writes [12 bytes IV] + [encrypted payload] + [16 bytes authentication tag]
 */
export class AesGcmEncryptStream extends Transform {
  private cipher: crypto.CipherGCM | null = null;
  private key: Buffer;
  private iv: Buffer;
  private ivWritten = false;

  constructor(passphrase: string) {
    super();
    this.key = deriveKey(passphrase);
    this.iv = crypto.randomBytes(12); // standard 12-byte IV for GCM
  }

  _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!this.ivWritten) {
        // First chunk: write the IV to the output stream
        this.push(this.iv);
        this.ivWritten = true;
        // Initialize the cipher
        this.cipher = crypto.createCipheriv('aes-256-gcm', this.key, this.iv);
      }

      if (this.cipher) {
        const encrypted = this.cipher.update(chunk);
        if (encrypted.length > 0) {
          this.push(encrypted);
        }
      }
      callback();
    } catch (err: any) {
      callback(err);
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      if (!this.ivWritten) {
        // If we never wrote anything (empty input), initialize anyway
        this.push(this.iv);
        this.cipher = crypto.createCipheriv('aes-256-gcm', this.key, this.iv);
      }

      if (this.cipher) {
        const final = this.cipher.final();
        if (final.length > 0) {
          this.push(final);
        }
        // Append the 16-byte authentication tag
        const authTag = this.cipher.getAuthTag();
        this.push(authTag);
      }
      callback();
    } catch (err: any) {
      callback(err);
    }
  }
}

/**
 * Decrypts a stream using AES-256-GCM.
 * Expects [12 bytes IV] + [encrypted payload] + [16 bytes authentication tag]
 */
export class AesGcmDecryptStream extends Transform {
  private decipher: crypto.DecipherGCM | null = null;
  private key: Buffer;
  
  // Buffer to accumulate the first 12 bytes (IV)
  private ivBuffer = Buffer.alloc(0);
  
  // Sliding buffer to keep the trailing 16 bytes (Auth Tag)
  private slideBuffer = Buffer.alloc(0);
  
  private ivRead = false;

  constructor(passphrase: string) {
    super();
    this.key = deriveKey(passphrase);
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let data = Buffer.concat([this.slideBuffer, chunk]);

      // 1. Read IV first if not yet initialized
      if (!this.ivRead) {
        const neededIVBytes = 12 - this.ivBuffer.length;
        if (data.length < neededIVBytes) {
          this.ivBuffer = Buffer.concat([this.ivBuffer, data]);
          this.slideBuffer = Buffer.alloc(0);
          return callback();
        }

        const ivPart = data.subarray(0, neededIVBytes);
        this.ivBuffer = Buffer.concat([this.ivBuffer, ivPart]);
        const iv = this.ivBuffer;
        this.ivRead = true;

        // Initialize decipher
        this.decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        
        // Keep the rest of the data
        data = data.subarray(neededIVBytes);
      }

      // 2. Manage sliding buffer for auth tag (trailing 16 bytes)
      if (data.length <= 16) {
        this.slideBuffer = data;
      } else {
        // We have more than 16 bytes. The part before the last 16 bytes is ciphertext.
        const cipherPart = data.subarray(0, data.length - 16);
        this.slideBuffer = data.subarray(data.length - 16);

        if (this.decipher) {
          const decrypted = this.decipher.update(cipherPart);
          if (decrypted.length > 0) {
            this.push(decrypted);
          }
        }
      }
      callback();
    } catch (err: any) {
      callback(err);
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      if (!this.ivRead) {
        return callback(new Error('Invalid backup file: file too short to read initialization vector.'));
      }

      if (this.slideBuffer.length !== 16) {
        return callback(new Error('Invalid backup file: file too short to read authentication tag.'));
      }

      if (this.decipher) {
        // Set the auth tag
        this.decipher.setAuthTag(this.slideBuffer);
        const final = this.decipher.final();
        if (final.length > 0) {
          this.push(final);
        }
      }
      callback();
    } catch (err: any) {
      callback(new Error(`Decryption failed: integrity check failed. ${err.message}`));
    }
  }
}
