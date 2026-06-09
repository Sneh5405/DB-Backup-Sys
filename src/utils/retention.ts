import fs from 'fs';
import path from 'path';
import { loadManifest, saveManifest, ManifestEntry } from './manifest.js';
import logger from './logger.js';

/**
 * Prunes local backups that exceed the configured retention days.
 */
export async function pruneLocalBackups(
  outputDir: string,
  retentionDays: number,
  dbType: string,
  dbName: string
): Promise<number> {
  if (retentionDays <= 0) {
    logger.debug('Retention policy disabled (retentionDays <= 0)');
    return 0;
  }

  logger.info(`Running local retention policy: keeping last ${retentionDays} days of backups for database "${dbName}"`);
  
  const manifest = loadManifest(outputDir);
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTime = now - retentionMs;

  const keptEntries: ManifestEntry[] = [];
  let deletedCount = 0;

  for (const entry of manifest) {
    const backupTime = new Date(entry.timestamp).getTime();
    
    // Check if this entry belongs to the current database and is older than the cutoff
    if (
      entry.dbType === dbType &&
      entry.dbName === dbName &&
      entry.status === 'success' &&
      backupTime < cutoffTime
    ) {
      const filePath = path.resolve(entry.filePath);
      logger.info(`Pruning expired backup: ${entry.fileName} (created ${entry.timestamp})`);
      
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.info(`Deleted file: ${filePath}`);
        } else {
          logger.warn(`Backup file not found on disk at: ${filePath}`);
        }
        deletedCount++;
      } catch (err: any) {
        logger.error(`Failed to delete backup file ${filePath}: ${err.message}`);
        // If file delete failed, we keep it in the manifest to retry later
        keptEntries.push(entry);
      }
    } else {
      keptEntries.push(entry);
    }
  }

  if (deletedCount > 0) {
    saveManifest(outputDir, keptEntries);
    logger.info(`Retention policy run finished. Pruned ${deletedCount} local backups.`);
  } else {
    logger.info('Retention policy run finished. No files were expired.');
  }

  return deletedCount;
}
