import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DbConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Finds the MySQL binary (mysqldump or mysql) on the system.
 */
export function resolveMysqlBin(binName: string, customPath?: string): string {
  if (customPath) {
    if (fs.existsSync(customPath)) {
      if (fs.statSync(customPath).isFile()) {
        return customPath;
      }
      const fullPath = path.join(customPath, `${binName}.exe`);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // Windows automatic lookup
  if (process.platform === 'win32') {
    const defaultMysqlDir = 'C:\\Program Files\\MySQL';
    if (fs.existsSync(defaultMysqlDir)) {
      try {
        const subdirs = fs.readdirSync(defaultMysqlDir);
        for (const dir of subdirs) {
          if (dir.startsWith('MySQL Server')) {
            const binPath = path.join(defaultMysqlDir, dir, 'bin', `${binName}.exe`);
            if (fs.existsSync(binPath)) {
              logger.debug(`Auto-detected ${binName} at: ${binPath}`);
              return binPath;
            }
          }
        }
      } catch (err: any) {
        logger.debug(`Error during auto-detecting MySQL path: ${err.message}`);
      }
    }
  }

  // Fallback to standard path execution
  return binName;
}

/**
 * Backs up MySQL database by executing mysqldump and writing to stream.
 */
export function backupMysql(config: DbConfig, writeStream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.name) {
      return reject(new Error('Database name is required for MySQL backup.'));
    }

    const mysqldumpBin = resolveMysqlBin('mysqldump', config.mysqlDumpPath);
    const args: string[] = [];

    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-P', String(config.port));
    if (config.user) args.push('-u', config.user);

    args.push(config.name);

    logger.debug(`Running command: ${mysqldumpBin} ${args.join(' ')}`);

    const env = { ...process.env };
    if (config.password) {
      env.MYSQL_PWD = config.password;
    }

    const mysqlProcess = spawn(mysqldumpBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    mysqlProcess.stdout.pipe(writeStream);

    let stderrData = '';
    mysqlProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    mysqlProcess.on('error', (err) => {
      reject(new Error(`Failed to start mysqldump process: ${err.message}`));
    });

    mysqlProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`mysqldump process exited with code ${code}. Error: ${stderrData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Restores a MySQL database by piping SQL statements to mysql.
 */
export function restoreMysql(config: DbConfig, readStream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.name) {
      return reject(new Error('Database name is required for MySQL restore.'));
    }

    const mysqlBin = resolveMysqlBin('mysql', config.mysqlDumpPath ? path.dirname(config.mysqlDumpPath) : undefined);
    const args: string[] = [];

    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-P', String(config.port));
    if (config.user) args.push('-u', config.user);

    args.push(config.name);

    logger.debug(`Running command: ${mysqlBin} ${args.join(' ')}`);

    const env = { ...process.env };
    if (config.password) {
      env.MYSQL_PWD = config.password;
    }

    const mysqlProcess = spawn(mysqlBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    readStream.pipe(mysqlProcess.stdin);

    let stdoutData = '';
    let stderrData = '';

    mysqlProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    mysqlProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    mysqlProcess.on('error', (err) => {
      reject(new Error(`Failed to start mysql process: ${err.message}`));
    });

    mysqlProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`mysql process exited with code ${code}. Error: ${stderrData.trim() || stdoutData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Executes a raw query (e.g. CREATE/DROP DB) against the mysql database.
 */
export function executeMysqlQuery(config: DbConfig, query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mysqlBin = resolveMysqlBin('mysql', config.mysqlDumpPath ? path.dirname(config.mysqlDumpPath) : undefined);
    const args: string[] = [];
    if (config.host) args.push('-h', config.host);
    if (config.port) args.push('-P', String(config.port));
    if (config.user) args.push('-u', config.user);
    args.push('-e', query);

    const env = { ...process.env };
    if (config.password) {
      env.MYSQL_PWD = config.password;
    }

    const mysqlProcess = spawn(mysqlBin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrData = '';
    mysqlProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    mysqlProcess.on('error', (err) => {
      reject(new Error(`Failed to start mysql process for query: ${err.message}`));
    });

    mysqlProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`mysql query failed: ${stderrData.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Creates a database.
 */
export async function createMysqlDb(config: DbConfig, dbName: string): Promise<void> {
  logger.info(`Creating temporary database: ${dbName}`);
  await executeMysqlQuery(config, `CREATE DATABASE \`${dbName}\``);
}

/**
 * Drops a database.
 */
export async function dropMysqlDb(config: DbConfig, dbName: string): Promise<void> {
  logger.info(`Dropping temporary database: ${dbName}`);
  await executeMysqlQuery(config, `DROP DATABASE IF EXISTS \`${dbName}\``);
}

