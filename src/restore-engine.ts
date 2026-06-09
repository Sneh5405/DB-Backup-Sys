import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { AppConfig, DbConfig } from './utils/config.js';
import { createDecompressStream } from './utils/compressor.js';
import { ChecksumStream } from './utils/checksum.js';
import { AesGcmDecryptStream } from './encryptors/aes256gcm.js';
import { restorePostgres, createPostgresDb, dropPostgresDb } from './connectors/postgres.js';
import { restoreMysql, createMysqlDb, dropMysqlDb } from './connectors/mysql.js';
import { restoreSqlite } from './connectors/sqlite.js';
import { loadManifest } from './utils/manifest.js';
import logger from './utils/logger.js';

interface DetectedBackupSettings {
  dbType: 'postgres' | 'mysql' | 'sqlite';
  isCompressed: boolean;
  compressionType: 'gzip' | 'none';
  isEncrypted: boolean;
  encryptionType: 'aes-256-gcm' | 'none';
  originalChecksum?: string;
}

/**
 * Automatically detects compression, encryption, and dbType of a backup file
 * by checking the manifest catalog first, then parsing the file extensions.
 */
export function detectBackupSettings(filePath: string, outputDir: string, defaultDbType: 'postgres' | 'mysql' | 'sqlite'): DetectedBackupSettings {
  const fileName = path.basename(filePath);
  
  // 1. Try to load manifest from configured output directory
  let manifest = loadManifest(outputDir);
  let manifestMatch = manifest.find(m => m.fileName === fileName || path.resolve(m.filePath) === path.resolve(filePath));

  // 2. Fall back to loading manifest from the directory where the backup file itself resides
  if (!manifestMatch) {
    const fileDir = path.dirname(filePath);
    if (path.resolve(fileDir) !== path.resolve(outputDir)) {
      const fallbackManifest = loadManifest(fileDir);
      manifestMatch = fallbackManifest.find(m => m.fileName === fileName || path.resolve(m.filePath) === path.resolve(filePath));
    }
  }

  if (manifestMatch) {
    logger.debug(`Found backup entry in manifest: ${fileName}`);
    return {
      dbType: manifestMatch.dbType,
      isCompressed: manifestMatch.isCompressed,
      compressionType: manifestMatch.compressionType,
      isEncrypted: manifestMatch.isEncrypted,
      encryptionType: manifestMatch.encryptionType,
      originalChecksum: manifestMatch.fileChecksum,
    };
  }

  logger.debug(`Backup not found in manifest, falling back to extension parsing: ${fileName}`);
  
  // Extension-based detection
  const isEncrypted = fileName.endsWith('.enc');
  const baseNameWithoutEnc = isEncrypted ? fileName.slice(0, -4) : fileName;
  const isCompressed = baseNameWithoutEnc.endsWith('.gz');

  // Detect DB type from file prefix
  let dbType = defaultDbType;
  if (fileName.startsWith('backup-postgres-')) {
    dbType = 'postgres';
  } else if (fileName.startsWith('backup-mysql-')) {
    dbType = 'mysql';
  } else if (fileName.startsWith('backup-sqlite-')) {
    dbType = 'sqlite';
  }

  return {
    dbType,
    isCompressed,
    compressionType: isCompressed ? 'gzip' : 'none',
    isEncrypted,
    encryptionType: isEncrypted ? 'aes-256-gcm' : 'none',
  };
}

/**
 * Orchestrates restoring a database from backup.
 */
export async function runRestore(
  config: AppConfig,
  backupFilePath: string,
  options: { dryRun?: boolean; passphrase?: string }
): Promise<void> {
  const absolutePath = path.resolve(backupFilePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Backup file not found at: ${absolutePath}`);
  }

  // 1. Detect settings
  const settings = detectBackupSettings(absolutePath, config.backup.outputDir, config.database.type);
  logger.info(`Detected backup settings: DB=${settings.dbType}, Compressed=${settings.isCompressed}, Encrypted=${settings.isEncrypted}`);

  // 2. Prepare database configuration (handling dry-run temporary names)
  const targetDbConfig = { ...config.database, type: settings.dbType };
  let originalDbName = targetDbConfig.name || '';
  let originalSqlitePath = targetDbConfig.sqliteDbPath || '';

  const isDryRun = !!options.dryRun;
  let tempDbName = '';
  let tempSqlitePath = '';

  if (isDryRun) {
    logger.info('Performing validation DRY-RUN. A temporary database will be created and dropped.');
    const timestamp = Date.now();
    if (settings.dbType === 'sqlite') {
      tempSqlitePath = `${originalSqlitePath || './data.db'}.verify-${timestamp}`;
      targetDbConfig.sqliteDbPath = tempSqlitePath;
      logger.info(`Dry-run target SQLite file: ${tempSqlitePath}`);
    } else {
      tempDbName = `db_backup_verify_${timestamp}`;
      targetDbConfig.name = tempDbName;
      logger.info(`Dry-run target database name: ${tempDbName}`);
      
      // Create temporary database
      if (settings.dbType === 'postgres') {
        await createPostgresDb(config.database, tempDbName);
      } else if (settings.dbType === 'mysql') {
        await createMysqlDb(config.database, tempDbName);
      }
    }
  }

  // 3. Setup restore streams
  const fileReadStream = fs.createReadStream(absolutePath);
  const decryptStream = settings.isEncrypted 
    ? new AesGcmDecryptStream(options.passphrase || config.backup.passphrase || '') 
    : null;
  const decompressStream = createDecompressStream(settings.compressionType);
  const checksumStream = new ChecksumStream();

  if (settings.isEncrypted && !options.passphrase && !config.backup.passphrase) {
    throw new Error('Decryption passphrase is required for encrypted backups. Specify it via --passphrase or BACKUP_PASSPHRASE env.');
  }

  try {
    // Pipeline setup: File stream -> Checksum -> (Decrypt) -> (Decompress) -> DB restore connector
    logger.info(`Restoring backup data stream into database...`);

    // Run the decryption/decompression pipeline, keeping it active as a readable stream
    // to pipe into the connector
    const pipelinePromise = settings.isEncrypted
      ? pipeline(fileReadStream, checksumStream, decryptStream!, decompressStream)
      : pipeline(fileReadStream, checksumStream, decompressStream);

    // Define the database restore execution promise
    const restorePromise = (() => {
      if (settings.dbType === 'postgres') {
        return restorePostgres(targetDbConfig, decompressStream);
      } else if (settings.dbType === 'mysql') {
        return restoreMysql(targetDbConfig, decompressStream);
      } else if (settings.dbType === 'sqlite') {
        return restoreSqlite(targetDbConfig, decompressStream);
      }
      throw new Error(`Unsupported database type: ${settings.dbType}`);
    })();

    // Wait for both the pipeline and restore connector to complete.
    // Using Promise.all guarantees that if either fails, both rejections are tracked
    // and handled, preventing unhandled promise rejections.
    await Promise.all([pipelinePromise, restorePromise]);

    // 4. Verify integrity checksum
    const computedChecksum = checksumStream.getChecksum();
    logger.info(`Restore stream checksum calculated: ${computedChecksum}`);
    
    if (settings.originalChecksum) {
      if (computedChecksum === settings.originalChecksum) {
        logger.info('Integrity verification PASSED. Checksum matches the manifest record.');
      } else {
        throw new Error(`Integrity verification FAILED! Backup file checksum (${computedChecksum}) does not match original manifest checksum (${settings.originalChecksum})`);
      }
    } else {
      logger.warn('No manifest checksum found to verify integrity against.');
    }

    logger.info(`Restoration validation passed successfully!`);

  } catch (error: any) {
    logger.error(`Restoration/Validation failed: ${error.message}`);
    throw error;
  } finally {
    // 5. Clean up dry-run databases
    if (isDryRun) {
      if (settings.dbType === 'sqlite') {
        if (fs.existsSync(tempSqlitePath)) {
          try {
            fs.unlinkSync(tempSqlitePath);
            logger.info(`Cleaned up temporary SQLite dry-run file: ${tempSqlitePath}`);
          } catch (cleanErr: any) {
            logger.error(`Failed to clean up dry-run SQLite file: ${cleanErr.message}`);
          }
        }
      } else {
        try {
          if (settings.dbType === 'postgres') {
            await dropPostgresDb(config.database, tempDbName);
          } else if (settings.dbType === 'mysql') {
            await dropMysqlDb(config.database, tempDbName);
          }
        } catch (cleanErr: any) {
          logger.error(`Failed to drop temporary dry-run database: ${cleanErr.message}`);
        }
      }
    }
  }
}
