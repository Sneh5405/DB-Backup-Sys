import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import logger from '../utils/logger.js';

export interface S3UploadConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  keyPrefix?: string;
}

/**
 * Uploads a local file to AWS S3 (or compatible API) using multipart upload.
 */
export async function uploadToS3(filePath: string, fileName: string, config: S3UploadConfig): Promise<string> {
  const s3Client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.endpoint ? true : false,
  });

  const fileStream = fs.createReadStream(filePath);
  const fileKey = config.keyPrefix 
    ? `${config.keyPrefix.replace(/\/$/, '')}/${fileName}` 
    : fileName;

  logger.info(`Uploading ${fileName} to S3 bucket "${config.bucket}"...`);

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.bucket,
      Key: fileKey,
      Body: fileStream,
    },
  });

  let lastPercent = 0;
  upload.on('httpUploadProgress', (progress) => {
    if (progress.loaded && progress.total) {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      if (percentage >= lastPercent + 10 || percentage === 100) {
        logger.info(`S3 Upload Progress: ${percentage}% (${progress.loaded}/${progress.total} bytes)`);
        lastPercent = percentage;
      }
    }
  });

  await upload.done();
  logger.info(`S3 Upload successful: ${fileKey}`);
  return `s3://${config.bucket}/${fileKey}`;
}
