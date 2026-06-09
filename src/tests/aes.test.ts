import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';
import { AesGcmEncryptStream, AesGcmDecryptStream } from '../encryptors/aes256gcm.js';
import logger from '../utils/logger.js';

async function runTest() {
  logger.info('Starting AES-256-GCM stream unit test...');
  
  const originalPlaintext = 'This is a secure data payload to be encrypted and decrypted using AES-256-GCM streaming pipelines.';
  const passphrase = 'unit-test-secret-passphrase';

  // 1. Setup Source Stream
  const source = Readable.from(Buffer.from(originalPlaintext));
  
  // Buffer to collect encrypted chunks
  const encryptedChunks: Buffer[] = [];
  const encryptDestination = new Writable({
    write(chunk, encoding, callback) {
      encryptedChunks.push(chunk);
      callback();
    }
  });

  // 2. Run Encryption Pipeline
  const encryptor = new AesGcmEncryptStream(passphrase);
  await pipeline(source, encryptor, encryptDestination);
  
  const encryptedBuffer = Buffer.concat(encryptedChunks);
  logger.info(`Encryption finished. Original size: ${originalPlaintext.length} bytes, Encrypted size (with IV & Tag): ${encryptedBuffer.length} bytes`);

  // 3. Setup Decryption Pipeline
  const encryptedSource = Readable.from(encryptedBuffer);
  const decryptedChunks: Buffer[] = [];
  const decryptDestination = new Writable({
    write(chunk, encoding, callback) {
      decryptedChunks.push(chunk);
      callback();
    }
  });

  const decryptor = new AesGcmDecryptStream(passphrase);
  await pipeline(encryptedSource, decryptor, decryptDestination);

  const decryptedPlaintext = Buffer.concat(decryptedChunks).toString('utf-8');

  // 4. Verification Assert
  if (decryptedPlaintext === originalPlaintext) {
    logger.info('✅ UNIT TEST PASSED: Decrypted plaintext matches the original content exactly!');
  } else {
    logger.error('❌ UNIT TEST FAILED: Decrypted output is mismatching!');
    process.exit(1);
  }
}

runTest().catch((err) => {
  logger.error('❌ UNIT TEST ERROR: ' + err.message);
  process.exit(1);
});
