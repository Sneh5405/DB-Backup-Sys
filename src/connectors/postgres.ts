import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DbConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Finds the PostgreSQL binary (pg_dump or psql) on the system.
 */
export function resolvePgBin(binName: string, customPath?: string): string {
  if (customPath) {
    if (fs.existsSync(customPath)) {
      // If custom path points directly to file, return it
      if (fs.statSync(customPath).isFile()) {
        return customPath;
      }
      // If it's a directory, append the bin name
      const fullPath = path.join(customPath, `${binName}.exe`);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // Windows automatic lookup
  if (process.platform === 'win32') {
    const defaultPgDir = 'C:\\Program Files\\PostgreSQL';
    if (fs.existsSync(defaultPgDir)) {
      try {
        const versions = fs.readdirSync(defaultPgDir)
          .filter(f => fs.statSync(path.join(defaultPgDir, f)).isDirectory())
          .map(Number)
          .filter(n => !isNaN(n))
          .sort((a, b) => b - a); // Sort descending

        for (const ver of versions) {
          const binPath = path.join(defaultPgDir, String(ver), 'bin', `${binName}.exe`);
          if (fs.existsSync(binPath)) {
            logger.debug(`Auto-detected ${binName} at: ${binPath}`);
            return binPath;
          }
        }
      } catch (err: any) {
        logger.debug(`Error during auto-detecting PG path: ${err.message}`);
      }
    }
  }

  // Fallback to standard path execution
  return binName;
}

/**
 * Backs up PostgreSQL database by executing pg_dump and writing to stream.
 */
export function backupPostgres(config: DbConfig, writeStream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.name) {
      return reject(new Error('Database name is required for PostgreSQL backup.'));
    }

    const pgDumpBin = resolvePgBin('pg_dump', config.pgDumpPath);
    const args: string[] = [];

    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-p', String(config.port));
    if (config.user) args.push('-U', config.user);

    // Clean (drop) database objects before recreating them to prevent conflicts on existing targets
    args.push('--clean', '--if-exists');

    // Default to plain SQL text format
    args.push(config.name);

    logger.debug(`Running command: ${pgDumpBin} ${args.map(a => a === config.password ? '****' : a).join(' ')}`);

    const env = { ...process.env };
    if (config.password) {
      env.PGPASSWORD = config.password;
    }

    const pgDumpProcess = spawn(pgDumpBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    pgDumpProcess.stdout.pipe(writeStream);

    let stderrData = '';
    pgDumpProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    pgDumpProcess.on('error', (err) => {
      reject(new Error(`Failed to start pg_dump process: ${err.message}`));
    });

    pgDumpProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump process exited with code ${code}. Error: ${stderrData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Restores a PostgreSQL database by piping SQL statements to psql.
 */
export function restorePostgres(config: DbConfig, readStream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.name) {
      return reject(new Error('Database name is required for PostgreSQL restore.'));
    }

    const psqlBin = resolvePgBin('psql', config.pgDumpPath ? path.dirname(config.pgDumpPath) : undefined);
    const args: string[] = [];

    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-p', String(config.port));
    if (config.user) args.push('-U', config.user);
    
    // Add flag to stop on first error to ensure integrity
    args.push('-v', 'ON_ERROR_STOP=1');
    args.push(config.name);

    logger.debug(`Running command: ${psqlBin} ${args.join(' ')}`);

    const env = { ...process.env };
    if (config.password) {
      env.PGPASSWORD = config.password;
    }

    const psqlProcess = spawn(psqlBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    readStream.pipe(psqlProcess.stdin);

    let stdoutData = '';
    let stderrData = '';

    psqlProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    psqlProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    psqlProcess.on('error', (err) => {
      reject(new Error(`Failed to start psql process: ${err.message}`));
    });

    psqlProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql process exited with code ${code}. Error: ${stderrData.trim() || stdoutData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Executes a raw query (e.g. CREATE/DROP DB) against the postgres system DB.
 */
export function executePostgresQuery(config: DbConfig, query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const psqlBin = resolvePgBin('psql', config.pgDumpPath ? path.dirname(config.pgDumpPath) : undefined);
    const args: string[] = [];
    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-p', String(config.port));
    if (config.user) args.push('-U', config.user);
    args.push('-d', 'postgres');
    args.push('-c', query);

    const env = { ...process.env };
    if (config.password) {
      env.PGPASSWORD = config.password;
    }

    const psqlProcess = spawn(psqlBin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrData = '';
    psqlProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    psqlProcess.on('error', (err) => {
      reject(new Error(`Failed to start psql process for query: ${err.message}`));
    });

    psqlProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql query failed: ${stderrData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Creates a database.
 */
export async function createPostgresDb(config: DbConfig, dbName: string): Promise<void> {
  logger.info(`Creating temporary database: ${dbName}`);
  await executePostgresQuery(config, `CREATE DATABASE "${dbName}"`);
}

/**
 * Drops a database.
 */
export async function dropPostgresDb(config: DbConfig, dbName: string): Promise<void> {
  logger.info(`Dropping temporary database: ${dbName}`);
  // Force drop database disconnects active connections
  await executePostgresQuery(config, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
}

