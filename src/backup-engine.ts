import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { AppConfig, DbConfig, parseConnectionString } from './utils/config.js';
import { createCompressStream } from './utils/compressor.js';
import { ChecksumStream } from './utils/checksum.js';
import { AesGcmEncryptStream } from './encryptors/aes256gcm.js';
import { backupPostgres } from './connectors/postgres.js';
import { backupMysql } from './connectors/mysql.js';
import { backupSqlite } from './connectors/sqlite.js';
import { addBackupToManifest, ManifestEntry } from './utils/manifest.js';
import logger from './utils/logger.js';
import { uploadToS3 } from './remotes/s3.js';
import { uploadToSftp } from './remotes/sftp.js';
import { pruneLocalBackups } from './utils/retention.js';
import { sendNotification } from './utils/notifications.js';

/**
 * Generates a standard timestamp-based filename for backups.
 */
export function generateBackupFilename(
  dbType: string,
  dbName: string,
  compress: 'gzip' | 'none',
  encrypt: boolean
): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, '')     // remove dashes and colons
    .replace(/\..+/, '')      // remove milliseconds
    .replace('T', '-');       // replace T with dash
  
  const dbCleanName = path.basename(dbName).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = compress === 'gzip' ? 'sql.gz' : (dbType === 'sqlite' ? 'db' : 'sql');
  const fileBasename = `backup-${dbType}-${dbCleanName}-${timestamp}.${ext}`;
  return encrypt ? `${fileBasename}.enc` : fileBasename;
}

/**
 * Orchestrates a database backup flow.
 */
export async function runBackup(config: AppConfig): Promise<ManifestEntry> {
  const { database, backup } = config;
  const timestamp = new Date().toISOString();
  const id = `${database.type}-${Date.now()}`;

  // Ensure output directory exists
  const outputDir = path.resolve(backup.outputDir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const isEncrypted = !!(backup.encrypt && backup.passphrase);
  const dbName = database.type === 'sqlite' ? (database.sqliteDbPath || 'sqlite') : (database.name || 'db');
  const fileName = generateBackupFilename(database.type, dbName, backup.compress, isEncrypted);
  const filePath = path.join(outputDir, fileName);

  logger.info(`Starting backup for ${database.type} database: ${dbName}`);
  logger.info(`Destination: ${filePath}`);

  // Create stream transformations
  const compressStream = createCompressStream(backup.compress);
  const encryptStream = isEncrypted ? new AesGcmEncryptStream(backup.passphrase!) : null;
  const checksumStream = new ChecksumStream();
  const fileWriteStream = fs.createWriteStream(filePath);

  const manifestEntry: ManifestEntry = {
    id,
    timestamp,
    dbType: database.type,
    dbName,
    fileName,
    filePath,
    fileSize: 0,
    fileChecksum: '',
    isCompressed: backup.compress === 'gzip',
    compressionType: backup.compress,
    isEncrypted,
    encryptionType: isEncrypted ? 'aes-256-gcm' : 'none',
    destination: 'local',
    status: 'failed',
  };

  try {
    // Start the pipeline first so it's ready to receive data written to compressStream
    const pipelinePromise = encryptStream
      ? pipeline(compressStream, encryptStream, checksumStream, fileWriteStream)
      : pipeline(compressStream, checksumStream, fileWriteStream);

    // Define the database backup execution promise
    const backupPromise = (() => {
      if (database.type === 'postgres') {
        return backupPostgres(database, compressStream);
      } else if (database.type === 'mysql') {
        return backupMysql(database, compressStream);
      } else if (database.type === 'sqlite') {
        return backupSqlite(database, compressStream);
      }
      throw new Error(`Unsupported database type: ${database.type}`);
    })();

    // Wait for both the pipeline and backup connector to complete.
    // Using Promise.all guarantees that if either fails, both rejections are tracked
    // and handled, preventing unhandled promise rejections.
    await Promise.all([pipelinePromise, backupPromise]);

    // Get final specs
    const stats = fs.statSync(filePath);
    const checksum = checksumStream.getChecksum();

    manifestEntry.status = 'success';
    manifestEntry.fileSize = stats.size;
    manifestEntry.fileChecksum = checksum;

    // Handle remote storage upload
    if (backup.remoteProvider === 's3' && backup.s3) {
      if (!backup.s3.bucket || !backup.s3.region || !backup.s3.accessKeyId || !backup.s3.secretAccessKey) {
        throw new Error('S3 remote provider selected but credentials/bucket/region are not fully configured.');
      }
      const s3Url = await uploadToS3(filePath, fileName, {
        bucket: backup.s3.bucket,
        region: backup.s3.region,
        accessKeyId: backup.s3.accessKeyId,
        secretAccessKey: backup.s3.secretAccessKey,
        endpoint: backup.s3.endpoint,
        keyPrefix: backup.s3.keyPrefix,
      });
      manifestEntry.destination = 's3';
    } else if (backup.remoteProvider === 'sftp' && backup.sftp) {
      if (!backup.sftp.host || !backup.sftp.username || (!backup.sftp.password && !backup.sftp.privateKey) || !backup.sftp.remoteDir) {
        throw new Error('SFTP remote provider selected but server host/username/password/remoteDir are not fully configured.');
      }
      const sftpUrl = await uploadToSftp(filePath, fileName, {
        host: backup.sftp.host,
        port: backup.sftp.port,
        username: backup.sftp.username,
        password: backup.sftp.password,
        privateKey: backup.sftp.privateKey,
        remoteDir: backup.sftp.remoteDir,
      });
      manifestEntry.destination = 'sftp';
    }

    addBackupToManifest(backup.outputDir, manifestEntry);
    logger.info(`Backup completed successfully! Checksum: ${checksum}`);

    // Send Slack notification if configured
    if (backup.slackWebhookUrl) {
      await sendNotification(
        backup.slackWebhookUrl,
        'success',
        `Database backup completed successfully!`,
        {
          dbType: database.type,
          dbName,
          fileName,
          fileSize: stats.size,
        }
      );
    }

    // Run local retention policy to auto-prune old backup files
    if (backup.retentionDays && backup.retentionDays > 0) {
      try {
        await pruneLocalBackups(backup.outputDir, backup.retentionDays, database.type, dbName);
      } catch (pruneErr: any) {
        logger.error(`Retention policy execution failed: ${pruneErr.message}`);
      }
    }

    return manifestEntry;

  } catch (error: any) {
    logger.error(`Backup failed: ${error.message}`);
    manifestEntry.error = error.message;
    
    // Attempt to clean up failed file if it exists
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupErr: any) {
        logger.debug(`Could not clean up failed backup file: ${cleanupErr.message}`);
      }
    }

    addBackupToManifest(backup.outputDir, manifestEntry);

    // Send Slack notification if configured
    if (backup.slackWebhookUrl) {
      await sendNotification(
        backup.slackWebhookUrl,
        'failed',
        `Database backup failed!`,
        {
          dbType: database.type,
          dbName,
          error: error.message,
        }
      );
    }

    throw error;
  }
}
