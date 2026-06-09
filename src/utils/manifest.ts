import fs from 'fs';
import path from 'path';
import logger from './logger.js';

export interface ManifestEntry {
  id: string;
  timestamp: string;
  dbType: 'postgres' | 'mysql' | 'sqlite';
  dbName: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileChecksum: string;
  isCompressed: boolean;
  compressionType: 'gzip' | 'none';
  isEncrypted: boolean;
  encryptionType: 'aes-256-gcm' | 'none';
  destination: 'local' | 's3' | 'gcs' | 'sftp';
  status: 'success' | 'failed';
  error?: string;
}

const MANIFEST_FILENAME = 'backups-manifest.json';

export function getManifestPath(outputDir: string): string {
  return path.join(path.resolve(outputDir), MANIFEST_FILENAME);
}

export function loadManifest(outputDir: string): ManifestEntry[] {
  const filePath = getManifestPath(outputDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(rawData) as ManifestEntry[];
  } catch (error: any) {
    logger.warn(`Failed to read/parse backup manifest at ${filePath}: ${error.message}. Returning empty catalog.`);
    return [];
  }
}

export function saveManifest(outputDir: string, manifest: ManifestEntry[]): void {
  const filePath = getManifestPath(outputDir);
  const dirPath = path.dirname(filePath);

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (error: any) {
    logger.error(`Failed to write backup manifest to ${filePath}: ${error.message}`);
  }
}

export function addBackupToManifest(outputDir: string, entry: ManifestEntry): void {
  const manifest = loadManifest(outputDir);
  manifest.push(entry);
  saveManifest(outputDir, manifest);
  logger.info(`Manifest catalog updated: ${entry.fileName} (${entry.fileSize} bytes)`);
}
