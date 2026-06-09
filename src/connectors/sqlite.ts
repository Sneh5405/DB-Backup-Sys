import fs from 'fs';
import path from 'path';
import { DbConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Backs up SQLite database by reading the database file and writing to stream.
 */
export function backupSqlite(config: DbConfig, writeStream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.sqliteDbPath) {
      return reject(new Error('SQLite database path (sqliteDbPath) is required for backup.'));
    }

    const resolvedPath = path.resolve(config.sqliteDbPath);
    if (!fs.existsSync(resolvedPath)) {
      return reject(new Error(`SQLite database file not found at: ${resolvedPath}`));
    }

    logger.debug(`Reading SQLite database file from: ${resolvedPath}`);

    const readStream = fs.createReadStream(resolvedPath);

    readStream.pipe(writeStream);

    readStream.on('error', (err) => {
      reject(new Error(`Failed to read SQLite file: ${err.message}`));
    });

    writeStream.on('error', (err) => {
      reject(new Error(`Failed to write SQLite backup stream: ${err.message}`));
    });

    readStream.on('end', () => {
      resolve();
    });
  });
}

/**
 * Restores SQLite database by writing stream directly to the database file path.
 */
export function restoreSqlite(config: DbConfig, readStream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.sqliteDbPath) {
      return reject(new Error('SQLite database path (sqliteDbPath) is required for restore.'));
    }

    const resolvedPath = path.resolve(config.sqliteDbPath);
    const dir = path.dirname(resolvedPath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err: any) {
      return reject(new Error(`Failed to create directory for SQLite database: ${err.message}`));
    }

    logger.debug(`Writing SQLite database file to: ${resolvedPath}`);

    const writeStream = fs.createWriteStream(resolvedPath);

    readStream.pipe(writeStream);

    readStream.on('error', (err) => {
      reject(new Error(`Failed to read restore stream: ${err.message}`));
    });

    writeStream.on('error', (err) => {
      reject(new Error(`Failed to write SQLite restore file: ${err.message}`));
    });

    writeStream.on('finish', () => {
      resolve();
    });
  });
}
