import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../../');
const envPath = path.join(packageRoot, '.env');

// Load .env file from the package root directory
dotenv.config({ path: envPath, override: true });

export interface DbConfig {
  type: 'postgres' | 'mysql' | 'sqlite';
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  name?: string;
  pgDumpPath?: string;
  mysqlDumpPath?: string;
  sqliteDbPath?: string;
}

export interface S3Config {
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  keyPrefix?: string;
}

export interface SftpConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  remoteDir?: string;
}

export interface BackupConfig {
  outputDir: string;
  compress: 'gzip' | 'none';
  encrypt?: boolean;
  passphrase?: string;
  keyFile?: string;
  retentionDays?: number;
  remoteProvider?: 'local' | 's3' | 'sftp';
  s3?: S3Config;
  sftp?: SftpConfig;
  slackWebhookUrl?: string;
}

export interface AppConfig {
  database: DbConfig;
  databases?: DbConfig[];
  backup: BackupConfig;
}

function resolveEnvValue(value: string | undefined): string | undefined {
  if (value && value.startsWith('env:')) {
    const envVarName = value.substring(4);
    return process.env[envVarName] || '';
  }
  return value;
}

export function parseConnectionString(connectionString: string): Partial<DbConfig> {
  const result: Partial<DbConfig> = {};
  try {
    if (connectionString.startsWith('file:')) {
      result.type = 'sqlite';
      result.sqliteDbPath = connectionString.substring(5);
    } else if (connectionString.startsWith('sqlite://')) {
      result.type = 'sqlite';
      result.sqliteDbPath = connectionString.substring(9);
    } else {
      const url = new URL(connectionString);
      const protocol = url.protocol.replace(':', '');
      if (protocol === 'postgresql' || protocol === 'postgres') {
        result.type = 'postgres';
      } else if (protocol === 'mysql') {
        result.type = 'mysql';
      }
      
      if (url.hostname) {
        result.host = url.hostname;
      }
      if (url.port) {
        result.port = parseInt(url.port, 10);
      }
      if (url.username) {
        result.user = decodeURIComponent(url.username);
      }
      if (url.password) {
        result.password = decodeURIComponent(url.password);
      }
      if (url.pathname && url.pathname !== '/') {
        result.name = decodeURIComponent(url.pathname.substring(1));
      }
    }
  } catch (err: any) {
    throw new Error(`Failed to parse database connection string: ${err.message}`);
  }
  return result;
}

export function loadConfig(configPath?: string): AppConfig {
  // Read database connection string from environment if set
  const envConnStr = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || process.env.DB_CONNECTION_STRING || process.env.DB_URL || '';
  const parsedFromEnv = envConnStr ? parseConnectionString(envConnStr) : {};

  // 1. Establish default configuration from Environment Variables
  const defaultConfig: AppConfig = {
    database: {
      type: (parsedFromEnv.type || process.env.DB_TYPE || 'postgres') as 'postgres' | 'mysql' | 'sqlite',
      connectionString: envConnStr || undefined,
      host: parsedFromEnv.host || process.env.DB_HOST || 'localhost',
      port: parsedFromEnv.port || (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined),
      user: parsedFromEnv.user || process.env.DB_USER || '',
      password: parsedFromEnv.password || process.env.DB_PASSWORD || '',
      name: parsedFromEnv.name || process.env.DB_NAME || '',
      pgDumpPath: process.env.PG_DUMP_PATH || '',
      mysqlDumpPath: process.env.MYSQLDUMP_PATH || '',
      sqliteDbPath: parsedFromEnv.sqliteDbPath || process.env.SQLITE_DB_PATH || '',
    },
    backup: {
      outputDir: process.env.BACKUP_OUTPUT_DIR || './backups',
      compress: (process.env.COMPRESSION || 'gzip') as 'gzip' | 'none',
      encrypt: process.env.BACKUP_PASSPHRASE || process.env.BACKUP_KEY_FILE ? true : false,
      passphrase: process.env.BACKUP_PASSPHRASE || '',
      keyFile: process.env.BACKUP_KEY_FILE || '',
      retentionDays: process.env.RETENTION_DAYS ? parseInt(process.env.RETENTION_DAYS, 10) : undefined,
      remoteProvider: (process.env.REMOTE_PROVIDER || 'local') as 'local' | 's3' | 'sftp',
      s3: {
        bucket: process.env.S3_BUCKET || '',
        region: process.env.S3_REGION || '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        endpoint: process.env.S3_ENDPOINT || '',
        keyPrefix: process.env.S3_KEY_PREFIX || '',
      },
      sftp: {
        host: process.env.SFTP_HOST || '',
        port: process.env.SFTP_PORT ? parseInt(process.env.SFTP_PORT, 10) : undefined,
        username: process.env.SFTP_USERNAME || '',
        password: process.env.SFTP_PASSWORD || '',
        privateKey: process.env.SFTP_PRIVATE_KEY || '',
        remoteDir: process.env.SFTP_REMOTE_DIR || '',
      },
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    },
  };

  // Resolve relative paths to be relative to the package installation directory (packageRoot)
  if (defaultConfig.backup.outputDir && (defaultConfig.backup.outputDir.startsWith('./') || defaultConfig.backup.outputDir.startsWith('../'))) {
    defaultConfig.backup.outputDir = path.resolve(packageRoot, defaultConfig.backup.outputDir);
  }
  if (defaultConfig.backup.keyFile && (defaultConfig.backup.keyFile.startsWith('./') || defaultConfig.backup.keyFile.startsWith('../'))) {
    defaultConfig.backup.keyFile = path.resolve(packageRoot, defaultConfig.backup.keyFile);
  }
  if (defaultConfig.database.sqliteDbPath && (defaultConfig.database.sqliteDbPath.startsWith('./') || defaultConfig.database.sqliteDbPath.startsWith('../'))) {
    defaultConfig.database.sqliteDbPath = path.resolve(packageRoot, defaultConfig.database.sqliteDbPath);
  }

  // Read multi-db URLs from env if present (comma-separated)
  if (process.env.DB_URLS) {
    const urls = process.env.DB_URLS.split(',').map(s => s.trim()).filter(Boolean);
    defaultConfig.databases = urls.map(url => {
      const parsed = parseConnectionString(url);
      return {
        type: (parsed.type || 'postgres') as 'postgres' | 'mysql' | 'sqlite',
        connectionString: url,
        host: parsed.host || 'localhost',
        port: parsed.port,
        user: parsed.user || '',
        password: parsed.password || '',
        name: parsed.name || '',
        sqliteDbPath: parsed.sqliteDbPath || '',
      };
    });
  }

  // Set default ports based on database type if port is not specified
  if (defaultConfig.database.port === undefined) {
    if (defaultConfig.database.type === 'postgres') defaultConfig.database.port = 5432;
    if (defaultConfig.database.type === 'mysql') defaultConfig.database.port = 3306;
  }

  // 2. Override with config file if provided
  if (configPath) {
    const resolvedPath = path.resolve(configPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configuration file not found at: ${resolvedPath}`);
    }

    try {
      const rawData = fs.readFileSync(resolvedPath, 'utf-8');
      const fileConfig = JSON.parse(rawData);

      // Merge database config
      if (fileConfig.database) {
        const rawConnStr = fileConfig.database.connectionString;
        const resolvedConnStr = resolveEnvValue(rawConnStr);
        const parsedFromConfig = resolvedConnStr ? parseConnectionString(resolvedConnStr) : {};

        defaultConfig.database = {
          ...defaultConfig.database,
          ...parsedFromConfig,
          ...fileConfig.database,
        };
        defaultConfig.database.connectionString = resolvedConnStr || defaultConfig.database.connectionString;
      }

      // Merge databases list config
      if (Array.isArray(fileConfig.databases)) {
        defaultConfig.databases = fileConfig.databases.map((dbEntry: any) => {
          const rawConnStr = dbEntry.connectionString;
          const resolvedConnStr = resolveEnvValue(rawConnStr);
          const parsedFromConfig = resolvedConnStr ? parseConnectionString(resolvedConnStr) : {};

          const mergedDb: DbConfig = {
            type: (dbEntry.type || parsedFromConfig.type || 'postgres') as 'postgres' | 'mysql' | 'sqlite',
            connectionString: resolvedConnStr || undefined,
            host: resolveEnvValue(dbEntry.host) || parsedFromConfig.host || 'localhost',
            port: dbEntry.port !== undefined ? dbEntry.port : parsedFromConfig.port,
            user: resolveEnvValue(dbEntry.user) || parsedFromConfig.user || '',
            password: resolveEnvValue(dbEntry.password) || parsedFromConfig.password || '',
            name: resolveEnvValue(dbEntry.name) || parsedFromConfig.name || '',
            pgDumpPath: resolveEnvValue(dbEntry.pgDumpPath) || '',
            mysqlDumpPath: resolveEnvValue(dbEntry.mysqlDumpPath) || '',
            sqliteDbPath: resolveEnvValue(dbEntry.sqliteDbPath) || parsedFromConfig.sqliteDbPath || '',
          };

          return mergedDb;
        });
      }

      // Merge backup config
      if (fileConfig.backup) {
        defaultConfig.backup = {
          ...defaultConfig.backup,
          ...fileConfig.backup,
        };
      }

      // Resolve environment variables inside the configuration
      defaultConfig.database.password = resolveEnvValue(defaultConfig.database.password);
      defaultConfig.database.user = resolveEnvValue(defaultConfig.database.user);
      defaultConfig.database.host = resolveEnvValue(defaultConfig.database.host);
      defaultConfig.database.name = resolveEnvValue(defaultConfig.database.name);
      defaultConfig.database.pgDumpPath = resolveEnvValue(defaultConfig.database.pgDumpPath);
      defaultConfig.database.mysqlDumpPath = resolveEnvValue(defaultConfig.database.mysqlDumpPath);
      defaultConfig.database.sqliteDbPath = resolveEnvValue(defaultConfig.database.sqliteDbPath);

      defaultConfig.backup.passphrase = resolveEnvValue(defaultConfig.backup.passphrase);
      defaultConfig.backup.keyFile = resolveEnvValue(defaultConfig.backup.keyFile);
      defaultConfig.backup.slackWebhookUrl = resolveEnvValue(defaultConfig.backup.slackWebhookUrl);

      if (defaultConfig.backup.s3) {
        defaultConfig.backup.s3.bucket = resolveEnvValue(defaultConfig.backup.s3.bucket);
        defaultConfig.backup.s3.region = resolveEnvValue(defaultConfig.backup.s3.region);
        defaultConfig.backup.s3.accessKeyId = resolveEnvValue(defaultConfig.backup.s3.accessKeyId);
        defaultConfig.backup.s3.secretAccessKey = resolveEnvValue(defaultConfig.backup.s3.secretAccessKey);
        defaultConfig.backup.s3.endpoint = resolveEnvValue(defaultConfig.backup.s3.endpoint);
        defaultConfig.backup.s3.keyPrefix = resolveEnvValue(defaultConfig.backup.s3.keyPrefix);
      }

      if (defaultConfig.backup.sftp) {
        defaultConfig.backup.sftp.host = resolveEnvValue(defaultConfig.backup.sftp.host);
        defaultConfig.backup.sftp.username = resolveEnvValue(defaultConfig.backup.sftp.username);
        defaultConfig.backup.sftp.password = resolveEnvValue(defaultConfig.backup.sftp.password);
        defaultConfig.backup.sftp.privateKey = resolveEnvValue(defaultConfig.backup.sftp.privateKey);
        defaultConfig.backup.sftp.remoteDir = resolveEnvValue(defaultConfig.backup.sftp.remoteDir);
      }

    } catch (error: any) {
      throw new Error(`Failed to parse configuration file: ${error.message}`);
    }
  }

  // If keyFile is configured, read the passphrase from the file
  if (defaultConfig.backup.keyFile) {
    const keyFilePath = path.resolve(defaultConfig.backup.keyFile);
    if (fs.existsSync(keyFilePath)) {
      try {
        defaultConfig.backup.passphrase = fs.readFileSync(keyFilePath, 'utf-8').trim();
        defaultConfig.backup.encrypt = true;
      } catch (err: any) {
        throw new Error(`Failed to read key file at ${keyFilePath}: ${err.message}`);
      }
    } else {
      throw new Error(`Key file not found at: ${keyFilePath}`);
    }
  }

  // Force encrypt=true if passphrase is now present
  if (defaultConfig.backup.passphrase) {
    defaultConfig.backup.encrypt = true;
  }

  return defaultConfig;
}
