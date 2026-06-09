# Database Backup CLI Tool

A robust, stream-first command-line utility built with Node.js and TypeScript for database backup orchestration. Supports **PostgreSQL**, **MySQL**, and **SQLite** databases, offering automated compression, authenticated GCM encryption, manifest catalogs, local retention pruning, remote storage synchronization, and automation triggers.

---

## Features

- 🗄️ **Multi-DB Support**: Out-of-the-box integration with PostgreSQL (`pg_dump`/`psql`), MySQL (`mysqldump`/`mysql`), and SQLite files.
- 🔗 **Connection String Autodetect**: Automatically parses connection URIs (e.g. `DATABASE_URL`) from environment variables or command-line flags to resolve database types and credentials.
- ⚡ **Stream-First Pipeline**: Streams database outputs directly to compression, encryption, hashing, and write streams without blocking CPU or saturating disk buffers.
- 🔒 **AES-256-GCM Authenticated Encryption**: Secure encryption with authenticated tags ensuring no tampered or corrupted backups are ever restored.
- 📦 **Gzip Compression**: Stream compression via Node's native `zlib` API.
- 📋 **Manifest Catalog Tracking**: Updates `backups-manifest.json` after every backup run, cataloging timestamps, files, sizes, checksums, and states.
- ☁️ **Remote Storage Sync**: Sync backups to **AWS S3 / GCS** (multipart chunks) or **SFTP** (via `ssh2.fastPut`).
- 🗑️ **Local Retention Policy**: Auto-prunes local files exceeding configured age policies.
- 🛡️ **Pre-Restore Integrity Check**: Computes local file SHA-256 hashes and compares them to catalog logs *before* restoring begins, preventing corrupted database writes.
- 🧪 **Throwaway Dry-Run Restore**: Validates backup health by automatically creating a temporary verification database, importing the backup, performing SHA-256 integrity validation, and tearing down the database.
- ⏰ **Scheduling & Daemons**: Built-in cron task daemon with PID management, SIGHUP config reloading, and configuration templates for systemd, Windows Task Scheduler, and macOS launchd.

---

## Directory Structure

```text
├── bin/
│   └── index.js              # Entry wrapper (runs compiled JS or tsx dev fallback)
├── src/
│   ├── bin/
│   │   └── index.ts          # Main CLI commands definition (Commander)
│   ├── connectors/
│   │   ├── postgres.ts       # pg_dump / psql CLI stream wrappers (including clean drops)
│   │   ├── mysql.ts          # mysqldump / mysql CLI stream wrappers
│   │   └── sqlite.ts         # SQLite file copy stream wrappers
│   ├── encryptors/
│   │   └── aes256gcm.ts      # AES-256-GCM cipher/decipher transform streams
│   ├── remotes/
│   │   ├── s3.ts             # S3 multi-part client sync
│   │   └── sftp.ts           # SFTP server client sync
│   ├── scheduler/
│   │   ├── cron.ts           # Cron executor
│   │   └── templates.ts      # systemd / Windows XML / macOS plist generators
│   ├── utils/
│   │   ├── checksum.ts       # On-the-fly SHA-256 stream hasher
│   │   ├── compressor.ts     # Gzip compression stream
│   │   ├── config.ts         # .env and JSON config parser
│   │   ├── logger.ts         # Winston logging setup
│   │   ├── manifest.ts       # catalog-database JSON management
│   │   └── retention.ts      # Local file pruner
│   └── backup-engine.ts      # Pipeline orchestrator
├── package.json
└── tsconfig.json
```

---

## Installation

1. **Clone and Install Dependencies**:
   ```bash
   npm install
   ```

2. **Database Utilities**:
   Ensure native CLI tools (`pg_dump`/`psql` for Postgres, `mysqldump`/`mysql` for MySQL) are installed on your target machine. The CLI includes auto-discovery paths on Windows for standard installer locations, but you can also provide explicit overrides.

3. **Build the CLI**:
   ```bash
   npm run build
   ```

---

## Configuration

You can configure the tool using **Environment Variables** (stored in a `.env` file) or via a **JSON Configuration File** passed via CLI flags.

### 1. `.env` File Template
Create a `.env` file at the root:
```ini
# DB Settings (Single Database URL)
DATABASE_URL="postgresql://postgres:secret@localhost:5432/production_db"

# Or for multiple microservices, specify a comma-separated list of connection URLs:
# DB_URLS="postgresql://user:pass@host1:5432/db1,postgresql://user:pass@host2:5432/db2,mysql://user:pass@host3:3306/db3"

# Windows Executable Paths (Optional)
# PG_DUMP_PATH=C:\Program Files\PostgreSQL\16\bin\pg_dump.exe

# Local backup output
BACKUP_OUTPUT_DIR=./backups
COMPRESSION=gzip

# Security
BACKUP_PASSPHRASE=my_secure_decryption_passphrase

# Retention and Sync
RETENTION_DAYS=14
REMOTE_PROVIDER=s3
S3_BUCKET=my-backups-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=access_key
S3_SECRET_ACCESS_KEY=secret_key

# Slack notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/X00
```

### 2. JSON Config File Schema (`config.json`)
```json
{
  "database": {
    "connectionString": "env:DATABASE_URL"
  },
  "databases": [
    { "connectionString": "env:AUTH_DB_URL" },
    { "connectionString": "env:ORDER_DB_URL" }
  ],
  "backup": {
    "outputDir": "./backups",
    "compress": "gzip",
    "encrypt": true,
    "passphrase": "env:BACKUP_PASSPHRASE",
    "retentionDays": 14,
    "remoteProvider": "local"
  }
}
```

---

## CLI Usage & Command Reference

Run the command-line interface using:
`node bin/index.js <command> [options]`

### 1. `backup`
Triggers database backup. Loops automatically if multiple databases are configured.
```bash
# Basic backup using environment DATABASE_URL
node bin/index.js backup

# Backup using explicit connection string
node bin/index.js backup --url "postgresql://postgres:secret@localhost:5432/app_db" --compress gzip --encrypt --passphrase "mykey"

# Backup utilizing a custom JSON configuration file
node bin/index.js backup --config ./production.config.json
```

### 2. `restore`
Restores database. Automatically runs a SHA-256 pre-verification integrity check and auto-detects encryption/compression settings.
```bash
# Perform a live production restore
node bin/index.js restore ./backups/backup-postgres-app_db-date.sql.gz.enc --passphrase "mykey"

# Validate backup health safely by importing it into a temporary validation database
node bin/index.js restore ./backups/backup-postgres-app_db-date.sql.gz.enc --dry-run --passphrase "mykey"
```

### 3. `list`
Prints the local backup manifest index history catalog in a clean terminal table layout.
```bash
node bin/index.js list
```

### 4. `schedule`
Starts the built-in scheduler. Can be run in foreground or detached daemon mode.
```bash
# Start backup task scheduler running every 6 hours in the foreground
node bin/index.js schedule --cron "0 */6 * * *"

# Start the scheduler in background Daemon Mode
node bin/index.js schedule --cron "0 */6 * * *" --daemon --pid-file ./scheduler.pid
```
*Note: Send a `SIGHUP` signal to the daemon process (e.g. `kill -SIGHUP $(cat scheduler.pid)`) to hot-reload database configurations in-place.*

### 5. `stop`
Stops a running scheduler background daemon process.
```bash
node bin/index.js stop --pid-file ./scheduler.pid
```

### 6. `schedule-template`
Generates scheduling configuration templates for operating system services:
```bash
# Output Windows Task Scheduler XML Import Schema template
node bin/index.js schedule-template --type windows --cron "0 2 * * *" --args "backup"

# Write systemd service and timer config templates directly to files
node bin/index.js schedule-template --type systemd --cron "0 2 * * *" --output-file ./backup.timer

# Output macOS launchd plist task configuration template
node bin/index.js schedule-template --type macos --cron "0 2 * * *" --args "backup"
```

---

## Testing

Execute tests to verify cryptographic stream correctness and multi-db configuration loops:
```bash
npm test
```
