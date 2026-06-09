import { Command } from 'commander';
import { loadConfig, AppConfig, parseConnectionString } from '../utils/config.js';
import { runBackup } from '../backup-engine.js';
import { runRestore } from '../restore-engine.js';
import logger, { configureLogger } from '../utils/logger.js';
import { startScheduler } from '../scheduler/cron.js';
import { generateWindowsXml, generateSystemdService, generateSystemdTimer, generateMacOsPlist } from '../scheduler/templates.js';
import { loadManifest } from '../utils/manifest.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const program = new Command();

// Setup global options for logs/verbosity
program
  .name('db-backup')
  .description('A robust database backup, compression, encryption, and synchronization CLI tool')
  .version('1.0.0')
  .option('-v, --verbose', 'enable verbose log output (debug level)')
  .option('-q, --quiet', 'enable quiet log output (only error messages)')
  .option('--json', 'output logs in structured JSON format')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    configureLogger({
      verbose: opts.verbose,
      quiet: opts.quiet,
      logJson: opts.json,
    });
  });

// Backup Command
program
  .command('backup')
  .description('Execute database backup')
  .option('-c, --config <path>', 'path to JSON configuration file')
  .option('--db <postgres|mysql|sqlite>', 'database type')
  .option('--connection-string <string>', 'database connection URI (e.g. postgresql://user:pass@host:port/db)')
  .option('--url <string>', 'database connection URI (alias for --connection-string)')
  .option('--host <host>', 'database server host')
  .option('-p, --port <port>', 'database server port', (val) => parseInt(val, 10))
  .option('-u, --user <user>', 'database username')
  .option('--password <password>', 'database password')
  .option('-d, --database <name>', 'database name to backup')
  .option('-o, --output <path>', 'directory to write backup file')
  .option('--compress <gzip|none>', 'compression algorithm (gzip or none)')
  .option('--sqlite-db-path <path>', 'path to SQLite database file')
  .option('--pg-dump-path <path>', 'override path to pg_dump binary')
  .option('--mysql-dump-path <path>', 'override path to mysqldump binary')
  .option('--encrypt', 'encrypt backup file using AES-256-GCM')
  .option('--passphrase <passphrase>', 'passphrase for key derivation')
  .option('--key-file <path>', 'path to a file containing the passphrase')
  .option('--retention-days <days>', 'number of days to retain backups locally')
  .option('--remote-provider <local|s3|sftp>', 'remote storage provider to sync backups to')
  .option('--s3-bucket <bucket>', 'S3 bucket name')
  .option('--s3-region <region>', 'S3 region')
  .option('--s3-access-key <key>', 'S3 access key id')
  .option('--s3-secret-key <secret>', 'S3 secret access key')
  .option('--s3-endpoint <url>', 'S3 custom endpoint url')
  .option('--s3-prefix <prefix>', 'S3 destination key prefix')
  .option('--sftp-host <host>', 'SFTP host')
  .option('--sftp-port <port>', 'SFTP port', (val) => parseInt(val, 10))
  .option('--sftp-user <user>', 'SFTP username')
  .option('--sftp-pass <pass>', 'SFTP password')
  .option('--sftp-key <path>', 'SFTP private key file path')
  .option('--sftp-dir <dir>', 'SFTP remote directory path')
  .action(async (options) => {
    try {
      // 1. Load configuration from file (if provided) and environment variables
      const baseConfig = loadConfig(options.config);

      const connStr = options.connectionString || options.url;
      const cliParsed = connStr ? parseConnectionString(connStr) : {};

      // 2. Override configurations with CLI arguments if explicitly provided
      const finalConfig: AppConfig = {
        database: {
          type: options.db || cliParsed.type || baseConfig.database.type,
          connectionString: connStr || baseConfig.database.connectionString,
          host: options.host || cliParsed.host || baseConfig.database.host,
          port: options.port || cliParsed.port || baseConfig.database.port,
          user: options.user || cliParsed.user || baseConfig.database.user,
          password: options.password || cliParsed.password || baseConfig.database.password,
          name: options.database || cliParsed.name || baseConfig.database.name,
          sqliteDbPath: options.sqliteDbPath || cliParsed.sqliteDbPath || baseConfig.database.sqliteDbPath,
          pgDumpPath: options.pgDumpPath || baseConfig.database.pgDumpPath,
          mysqlDumpPath: options.mysqlDumpPath || baseConfig.database.mysqlDumpPath,
        },
        databases: baseConfig.databases,
        backup: {
          outputDir: options.output || baseConfig.backup.outputDir,
          compress: options.compress || baseConfig.backup.compress,
          encrypt: options.encrypt !== undefined ? options.encrypt : baseConfig.backup.encrypt,
          passphrase: options.passphrase || baseConfig.backup.passphrase,
          keyFile: options.keyFile || baseConfig.backup.keyFile,
          retentionDays: options.retentionDays !== undefined ? parseInt(options.retentionDays, 10) : baseConfig.backup.retentionDays,
          remoteProvider: options.remoteProvider || baseConfig.backup.remoteProvider,
          s3: {
            bucket: options.s3Bucket || (baseConfig.backup.s3 && baseConfig.backup.s3.bucket),
            region: options.s3Region || (baseConfig.backup.s3 && baseConfig.backup.s3.region),
            accessKeyId: options.s3AccessKey || (baseConfig.backup.s3 && baseConfig.backup.s3.accessKeyId),
            secretAccessKey: options.s3SecretKey || (baseConfig.backup.s3 && baseConfig.backup.s3.secretAccessKey),
            endpoint: options.s3Endpoint || (baseConfig.backup.s3 && baseConfig.backup.s3.endpoint),
            keyPrefix: options.s3Prefix || (baseConfig.backup.s3 && baseConfig.backup.s3.keyPrefix),
          },
          sftp: {
            host: options.sftpHost || (baseConfig.backup.sftp && baseConfig.backup.sftp.host),
            port: options.sftpPort !== undefined ? parseInt(options.sftpPort, 10) : (baseConfig.backup.sftp && baseConfig.backup.sftp.port),
            username: options.sftpUser || (baseConfig.backup.sftp && baseConfig.backup.sftp.username),
            password: options.sftpPass || (baseConfig.backup.sftp && baseConfig.backup.sftp.password),
            privateKey: options.sftpKey || (baseConfig.backup.sftp && baseConfig.backup.sftp.privateKey),
            remoteDir: options.sftpDir || (baseConfig.backup.sftp && baseConfig.backup.sftp.remoteDir),
          },
        },
      };

      // Ensure port is number
      if (finalConfig.database.port && typeof finalConfig.database.port === 'string') {
        finalConfig.database.port = parseInt(finalConfig.database.port, 10);
      }

      // Check if they want to backup a list of databases instead of a single one
      const hasCliOverrides = !!(
        options.db ||
        options.connectionString ||
        options.url ||
        options.host ||
        options.port ||
        options.user ||
        options.password ||
        options.database ||
        options.sqliteDbPath
      );

      // 3. Run backup
      if (!hasCliOverrides && finalConfig.databases && finalConfig.databases.length > 0) {
        logger.info(`Starting sequential backups for ${finalConfig.databases.length} databases...`);
        for (let i = 0; i < finalConfig.databases.length; i++) {
          const db = finalConfig.databases[i];
          logger.info(`[Database ${i + 1}/${finalConfig.databases.length}] Processing backup...`);
          const singleDbConfig: AppConfig = {
            database: db,
            backup: finalConfig.backup,
          };
          await runBackup(singleDbConfig);
        }
        logger.info(`All ${finalConfig.databases.length} database backups finished successfully!`);
      } else {
        await runBackup(finalConfig);
      }
    } catch (error: any) {
      logger.error(`Backup CLI command failed: ${error.message}`);
      process.exit(1);
    }
  });

// Restore Command
program
  .command('restore <file-path>')
  .description('Restore database from a backup file')
  .option('-c, --config <path>', 'path to JSON configuration file')
  .option('--db <postgres|mysql|sqlite>', 'database type override')
  .option('--connection-string <string>', 'database connection URI override')
  .option('--url <string>', 'database connection URI override (alias for --connection-string)')
  .option('--host <host>', 'database server host override')
  .option('-p, --port <port>', 'database server port override', (val) => parseInt(val, 10))
  .option('-u, --user <user>', 'database username override')
  .option('--password <password>', 'database password override')
  .option('-d, --database <name>', 'database name override to restore into')
  .option('--sqlite-db-path <path>', 'path to SQLite database file override')
  .option('--pg-dump-path <path>', 'override path to psql/pg_restore binary folder')
  .option('--mysql-dump-path <path>', 'override path to mysql binary folder')
  .option('--passphrase <passphrase>', 'decryption passphrase (if encrypted)')
  .option('--dry-run', 'validate backup by restoring into a temporary database without affecting production data')
  .action(async (filePath, options) => {
    try {
      const baseConfig = loadConfig(options.config);

      const connStr = options.connectionString || options.url;
      const cliParsed = connStr ? parseConnectionString(connStr) : {};

      const finalConfig: AppConfig = {
        database: {
          type: options.db || cliParsed.type || baseConfig.database.type,
          connectionString: connStr || baseConfig.database.connectionString,
          host: options.host || cliParsed.host || baseConfig.database.host,
          port: options.port || cliParsed.port || baseConfig.database.port,
          user: options.user || cliParsed.user || baseConfig.database.user,
          password: options.password || cliParsed.password || baseConfig.database.password,
          name: options.database || cliParsed.name || baseConfig.database.name,
          sqliteDbPath: options.sqliteDbPath || cliParsed.sqliteDbPath || baseConfig.database.sqliteDbPath,
          pgDumpPath: options.pgDumpPath || baseConfig.database.pgDumpPath,
          mysqlDumpPath: options.mysqlDumpPath || baseConfig.database.mysqlDumpPath,
        },
        backup: {
          outputDir: baseConfig.backup.outputDir,
          compress: baseConfig.backup.compress,
          passphrase: options.passphrase || baseConfig.backup.passphrase,
          keyFile: baseConfig.backup.keyFile,
        },
      };

      if (finalConfig.database.port && typeof finalConfig.database.port === 'string') {
        finalConfig.database.port = parseInt(finalConfig.database.port, 10);
      }

      await runRestore(finalConfig, filePath, {
        dryRun: options.dryRun,
        passphrase: options.passphrase,
      });
    } catch (error: any) {
      logger.error(`Restore CLI command failed: ${error.message}`);
      process.exit(1);
    }
  });

// Schedule Command
program
  .command('schedule')
  .description('Run built-in DB backup scheduler')
  .requiredOption('--cron <expression>', 'cron schedule expression (e.g. "0 2 * * *")')
  .option('-c, --config <path>', 'path to JSON configuration file')
  .option('--daemon', 'run scheduler continuously as a background daemon process')
  .option('--pid-file <path>', 'path to store process ID file', './db-backup.pid')
  .action(async (options) => {
    try {
      const pidFilePath = path.resolve(options.pidFile || './db-backup.pid');

      if (options.daemon) {
        // Parent process spawns detached child, then exits
        const args = process.argv.slice(2).filter(arg => arg !== '--daemon');
        const child = spawn(process.execPath, [process.argv[1], ...args], {
          detached: true,
          stdio: 'ignore',
        });

        fs.writeFileSync(pidFilePath, String(child.pid), 'utf-8');
        logger.info(`Scheduler started in background (Daemon Mode) with PID: ${child.pid}`);
        logger.info(`PID file written to: ${pidFilePath}`);
        child.unref();
        process.exit(0);
      }

      // Write PID file for the running process
      fs.writeFileSync(pidFilePath, String(process.pid), 'utf-8');
      logger.info(`Scheduler running with PID: ${process.pid}`);

      // Register exit/cleanup handlers to remove PID file
      const cleanupPid = () => {
        if (fs.existsSync(pidFilePath)) {
          try {
            fs.unlinkSync(pidFilePath);
            logger.debug(`PID file deleted: ${pidFilePath}`);
          } catch (err: any) {
            logger.debug(`Failed to delete PID file: ${err.message}`);
          }
        }
      };
      process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
      process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });
      process.on('exit', cleanupPid);

      const config = loadConfig(options.config);

      // Register SIGHUP listener to reload database configuration in-place
      process.on('SIGHUP', () => {
        logger.info('SIGHUP received. Reloading database configurations...');
        try {
          const newConfig = loadConfig(options.config);
          Object.assign(config, newConfig);
          logger.info('Configurations reloaded successfully!');
        } catch (err: any) {
          logger.error(`Failed to reload configuration: ${err.message}`);
        }
      });

      startScheduler(config, options.cron);
    } catch (error: any) {
      logger.error(`Scheduler failed to start: ${error.message}`);
      process.exit(1);
    }
  });

// Schedule-Template Command
program
  .command('schedule-template')
  .description('Generate template configuration for Windows, systemd, or macOS launchd')
  .requiredOption('--type <windows|systemd|macos>', 'type of template (windows, systemd, or macos)')
  .option('--cron <expression>', 'cron schedule expression', '0 2 * * *')
  .option('--args <arguments>', 'CLI arguments to pass to db-backup', 'backup')
  .option('--node-path <path>', 'override path to Node.js executable', process.execPath)
  .option('--output-file <path>', 'write template to a file path')
  .action(async (options) => {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      // Entry script of CLI tool is bin/index.js (root)
      const cliEntryPath = path.resolve(__dirname, '../../bin/index.js');
      
      let outputText = '';
      if (options.type === 'windows') {
        outputText = generateWindowsXml(options.cron, options.nodePath, cliEntryPath, options.args);
      } else if (options.type === 'systemd') {
        const workingDir = path.resolve(__dirname, '../..');
        const serviceContent = generateSystemdService(workingDir, options.nodePath, cliEntryPath, options.args);
        const timerContent = generateSystemdTimer(options.cron);
        outputText = `#### systemd Service Configuration (db-backup.service) ####\n\n${serviceContent}\n\n#### systemd Timer Configuration (db-backup.timer) ####\n\n${timerContent}`;
      } else if (options.type === 'macos') {
        outputText = generateMacOsPlist(options.cron, options.nodePath, cliEntryPath, options.args);
      } else {
        throw new Error('Unsupported template type: ' + options.type);
      }

      if (options.outputFile) {
        const outPath = path.resolve(options.outputFile);
        const parentDir = path.dirname(outPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(outPath, outputText, 'utf-8');
        logger.info(`Template written successfully to: ${outPath}`);
      } else {
        console.log(outputText);
      }
    } catch (error: any) {
      logger.error(`Failed to generate schedule template: ${error.message}`);
      process.exit(1);
    }
  });

// Stop Command
program
  .command('stop')
  .description('Stop the running scheduler daemon process')
  .option('--pid-file <path>', 'path to the process ID file', './db-backup.pid')
  .action(async (options) => {
    try {
      const pidFilePath = path.resolve(options.pidFile || './db-backup.pid');
      if (!fs.existsSync(pidFilePath)) {
        logger.error(`No running daemon found. PID file not found at: ${pidFilePath}`);
        process.exit(1);
      }

      const pidStr = fs.readFileSync(pidFilePath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) {
        logger.error(`Invalid PID in file: ${pidStr}`);
        process.exit(1);
      }

      logger.info(`Attempting to stop scheduler daemon with PID: ${pid}...`);
      try {
        process.kill(pid, 'SIGTERM');
        logger.info(`Daemon process ${pid} terminated successfully.`);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          logger.warn(`Process ${pid} is not running. Cleaning up stale PID file.`);
          if (fs.existsSync(pidFilePath)) {
            fs.unlinkSync(pidFilePath);
          }
        } else {
          throw err;
        }
      }
    } catch (error: any) {
      logger.error(`Failed to stop daemon: ${error.message}`);
      process.exit(1);
    }
  });

// List (Catalog) Command
program
  .command('list')
  .description('List all database backups recorded in the manifest catalog')
  .option('-c, --config <path>', 'path to JSON configuration file')
  .option('-o, --output <path>', 'directory containing the backups-manifest.json catalog')
  .action(async (options) => {
    try {
      const baseConfig = loadConfig(options.config);
      const outputDir = options.output || baseConfig.backup.outputDir;
      const manifest = loadManifest(outputDir);

      if (manifest.length === 0) {
        console.log(`No backups found in manifest catalog at: ${path.resolve(outputDir)}`);
        return;
      }

      const tableData = manifest.map((entry) => ({
        ID: entry.id,
        Timestamp: new Date(entry.timestamp).toLocaleString(),
        Database: entry.dbType,
        Name: entry.dbName,
        FileName: entry.fileName,
        Size: `${(entry.fileSize / 1024).toFixed(2)} KB`,
        Compressed: entry.isCompressed ? `Yes (${entry.compressionType})` : 'No',
        Encrypted: entry.isEncrypted ? `Yes (${entry.encryptionType})` : 'No',
        Destination: entry.destination,
        Status: entry.status === 'success' ? '✅ Success' : '❌ Failed',
      }));

      console.table(tableData);
    } catch (error: any) {
      logger.error(`List command failed: ${error.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
