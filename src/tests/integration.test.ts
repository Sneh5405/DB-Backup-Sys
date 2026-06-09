import fs from 'fs';
import path from 'path';
import { runBackup } from '../backup-engine.js';
import { runRestore } from '../restore-engine.js';
import { loadManifest, saveManifest, ManifestEntry } from '../utils/manifest.js';
import { generateWindowsXml, generateMacOsPlist } from '../scheduler/templates.js';
import { pruneLocalBackups } from '../utils/retention.js';
import { parseConnectionString } from '../utils/config.js';
import logger from '../utils/logger.js';

function filesAreEqual(file1: string, file2: string): boolean {
  const buf1 = fs.readFileSync(file1);
  const buf2 = fs.readFileSync(file2);
  return buf1.equals(buf2);
}

async function runIntegrationTests() {
  logger.info('🚀 Starting DB-Backup-Sys end-to-end integration tests...');

  const sandboxDir = path.resolve('./test-sandbox');

  // Clean up sandbox if left over
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Create a mock SQLite DB file
  const dbPath = path.join(sandboxDir, 'mock.db');
  const mockContent = 'SQLite format 3\u0000Mock database contents for backup testing. Hello world! '.repeat(100);
  fs.writeFileSync(dbPath, mockContent, 'utf-8');

  try {
    // ----------------------------------------------------
    // TEST 1: Uncompressed & Unencrypted SQLite Backup/Restore
    // ----------------------------------------------------
    logger.info('--- Test 1: SQLite Backup (No Compression, No Encryption) ---');
    const outDir1 = path.join(sandboxDir, 'backups1');
    const config1 = {
      database: {
        type: 'sqlite' as const,
        sqliteDbPath: dbPath,
      },
      backup: {
        outputDir: outDir1,
        compress: 'none' as const,
        encrypt: false,
        remoteProvider: 'local' as const,
      }
    };

    const entry1 = await runBackup(config1);
    const backupFile1 = entry1.filePath;
    
    // Asserts
    if (!fs.existsSync(backupFile1)) {
      throw new Error(`Backup file 1 was not created at ${backupFile1}`);
    }

    const manifest1 = loadManifest(outDir1);
    if (manifest1.length !== 1 || manifest1[0].status !== 'success') {
      throw new Error('Test 1 manifest verification failed.');
    }

    // Restore verification - Dry Run
    logger.info('Verifying restore dry-run...');
    await runRestore(config1, backupFile1, { dryRun: true });

    // Restore verification - Live Restore
    logger.info('Verifying live restore...');
    const restoredDbPath1 = path.join(sandboxDir, 'restored1.db');
    const restoreConfig1 = {
      ...config1,
      database: {
        ...config1.database,
        sqliteDbPath: restoredDbPath1,
      }
    };
    await runRestore(restoreConfig1, backupFile1, { dryRun: false });
    if (!filesAreEqual(dbPath, restoredDbPath1)) {
      throw new Error('Test 1 restored database is not identical to the original!');
    }
    logger.info('✅ Test 1 Passed!');

    // ----------------------------------------------------
    // TEST 2: Gzipped & Unencrypted SQLite Backup/Restore
    // ----------------------------------------------------
    logger.info('--- Test 2: SQLite Backup (Gzip Compression, No Encryption) ---');
    const outDir2 = path.join(sandboxDir, 'backups2');
    const config2 = {
      database: {
        type: 'sqlite' as const,
        sqliteDbPath: dbPath,
      },
      backup: {
        outputDir: outDir2,
        compress: 'gzip' as const,
        encrypt: false,
        remoteProvider: 'local' as const,
      }
    };

    const entry2 = await runBackup(config2);
    const backupFile2 = entry2.filePath;

    if (!fs.existsSync(backupFile2)) {
      throw new Error(`Backup file 2 was not created at ${backupFile2}`);
    }

    const manifest2 = loadManifest(outDir2);
    if (manifest2.length !== 1 || manifest2[0].isCompressed !== true) {
      throw new Error('Test 2 manifest verification failed.');
    }

    // Restore verification - Dry Run
    logger.info('Verifying restore dry-run...');
    await runRestore(config2, backupFile2, { dryRun: true });

    // Restore verification - Live Restore
    logger.info('Verifying live restore...');
    const restoredDbPath2 = path.join(sandboxDir, 'restored2.db');
    const restoreConfig2 = {
      ...config2,
      database: {
        ...config2.database,
        sqliteDbPath: restoredDbPath2,
      }
    };
    await runRestore(restoreConfig2, backupFile2, { dryRun: false });
    if (!filesAreEqual(dbPath, restoredDbPath2)) {
      throw new Error('Test 2 restored database is not identical to the original!');
    }
    logger.info('✅ Test 2 Passed!');

    // ----------------------------------------------------
    // TEST 3: Uncompressed & Encrypted SQLite Backup/Restore
    // ----------------------------------------------------
    logger.info('--- Test 3: SQLite Backup (No Compression, AES-256-GCM Encryption) ---');
    const outDir3 = path.join(sandboxDir, 'backups3');
    const passphrase3 = 'secret-test-key-3';
    const config3 = {
      database: {
        type: 'sqlite' as const,
        sqliteDbPath: dbPath,
      },
      backup: {
        outputDir: outDir3,
        compress: 'none' as const,
        encrypt: true,
        passphrase: passphrase3,
        remoteProvider: 'local' as const,
      }
    };

    const entry3 = await runBackup(config3);
    const backupFile3 = entry3.filePath;

    if (!fs.existsSync(backupFile3)) {
      throw new Error(`Backup file 3 was not created at ${backupFile3}`);
    }

    const manifest3 = loadManifest(outDir3);
    if (manifest3.length !== 1 || manifest3[0].isEncrypted !== true) {
      throw new Error('Test 3 manifest verification failed.');
    }

    // Restore verification - Dry Run
    logger.info('Verifying restore dry-run with correct passphrase...');
    await runRestore(config3, backupFile3, { dryRun: true, passphrase: passphrase3 });

    // Restore verification - Live Restore
    logger.info('Verifying live restore...');
    const restoredDbPath3 = path.join(sandboxDir, 'restored3.db');
    const restoreConfig3 = {
      ...config3,
      database: {
        ...config3.database,
        sqliteDbPath: restoredDbPath3,
      }
    };
    await runRestore(restoreConfig3, backupFile3, { dryRun: false, passphrase: passphrase3 });
    if (!filesAreEqual(dbPath, restoredDbPath3)) {
      throw new Error('Test 3 restored database is not identical to the original!');
    }

    // Restore verification - Failure paths
    logger.info('Verifying live restore with WRONG passphrase fails...');
    let threwError = false;
    try {
      await runRestore(restoreConfig3, backupFile3, { dryRun: true, passphrase: 'wrong-passphrase' });
    } catch (err) {
      threwError = true;
      logger.info('Expected restore error caught: ' + (err as Error).message);
    }
    if (!threwError) {
      throw new Error('Test 3 restoration with wrong passphrase should have thrown an error!');
    }

    logger.info('Verifying live restore with NO passphrase fails...');
    threwError = false;
    try {
      const configNoPass = { ...restoreConfig3, backup: { ...restoreConfig3.backup, passphrase: '' } };
      await runRestore(configNoPass, backupFile3, { dryRun: true });
    } catch (err) {
      threwError = true;
      logger.info('Expected restore error caught: ' + (err as Error).message);
    }
    if (!threwError) {
      throw new Error('Test 3 restoration with no passphrase should have thrown an error!');
    }

    logger.info('✅ Test 3 Passed!');

    // ----------------------------------------------------
    // TEST 4: Gzipped & Encrypted SQLite Backup/Restore
    // ----------------------------------------------------
    logger.info('--- Test 4: SQLite Backup (Gzip Compression, AES-256-GCM Encryption) ---');
    const outDir4 = path.join(sandboxDir, 'backups4');
    const passphrase4 = 'secret-test-key-4';
    const config4 = {
      database: {
        type: 'sqlite' as const,
        sqliteDbPath: dbPath,
      },
      backup: {
        outputDir: outDir4,
        compress: 'gzip' as const,
        encrypt: true,
        passphrase: passphrase4,
        remoteProvider: 'local' as const,
      }
    };

    const entry4 = await runBackup(config4);
    const backupFile4 = entry4.filePath;

    if (!fs.existsSync(backupFile4)) {
      throw new Error(`Backup file 4 was not created at ${backupFile4}`);
    }

    // Restore verification - Dry Run
    logger.info('Verifying restore dry-run...');
    await runRestore(config4, backupFile4, { dryRun: true, passphrase: passphrase4 });

    // Restore verification - Live Restore
    logger.info('Verifying live restore...');
    const restoredDbPath4 = path.join(sandboxDir, 'restored4.db');
    const restoreConfig4 = {
      ...config4,
      database: {
        ...config4.database,
        sqliteDbPath: restoredDbPath4,
      }
    };
    await runRestore(restoreConfig4, backupFile4, { dryRun: false, passphrase: passphrase4 });
    if (!filesAreEqual(dbPath, restoredDbPath4)) {
      throw new Error('Test 4 restored database is not identical to the original!');
    }
    logger.info('✅ Test 4 Passed!');

    // ----------------------------------------------------
    // TEST 5: Retention Policy Pruning
    // ----------------------------------------------------
    logger.info('--- Test 5: Local Retention Pruning Policy ---');
    const outDir5 = path.join(sandboxDir, 'backups5');
    fs.mkdirSync(outDir5, { recursive: true });

    const recentFile = path.join(outDir5, 'backup-sqlite-mock_db-recent.db');
    const oldFile = path.join(outDir5, 'backup-sqlite-mock_db-old.db');
    fs.writeFileSync(recentFile, 'recent content');
    fs.writeFileSync(oldFile, 'old content');

    const manifestEntries: ManifestEntry[] = [
      {
        id: 'recent-123',
        timestamp: new Date().toISOString(),
        dbType: 'sqlite',
        dbName: dbPath,
        fileName: 'backup-sqlite-mock_db-recent.db',
        filePath: recentFile,
        fileSize: 14,
        fileChecksum: 'recent-sha',
        isCompressed: false,
        compressionType: 'none',
        isEncrypted: false,
        encryptionType: 'none',
        destination: 'local',
        status: 'success'
      },
      {
        id: 'old-123',
        timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
        dbType: 'sqlite',
        dbName: dbPath,
        fileName: 'backup-sqlite-mock_db-old.db',
        filePath: oldFile,
        fileSize: 11,
        fileChecksum: 'old-sha',
        isCompressed: false,
        compressionType: 'none',
        isEncrypted: false,
        encryptionType: 'none',
        destination: 'local',
        status: 'success'
      }
    ];

    saveManifest(outDir5, manifestEntries);

    logger.info('Pruning with 2 days retention limit...');
    const prunedCount = await pruneLocalBackups(outDir5, 2, 'sqlite', dbPath);
    if (prunedCount !== 1) {
      throw new Error(`Expected retention to prune 1 file, but pruned ${prunedCount}`);
    }

    if (fs.existsSync(oldFile)) {
      throw new Error('Old backup file should have been deleted!');
    }
    if (!fs.existsSync(recentFile)) {
      throw new Error('Recent backup file should NOT have been deleted!');
    }

    const updatedManifest = loadManifest(outDir5);
    if (updatedManifest.length !== 1 || updatedManifest[0].id !== 'recent-123') {
      throw new Error('Manifest catalog was not updated properly after retention pruning!');
    }
    logger.info('✅ Test 5 Passed!');

    // ----------------------------------------------------
    // TEST 6: Windows Trigger Template Generator
    // ----------------------------------------------------
    logger.info('--- Test 6: Schedule Template Generation ---');
    const xml = generateWindowsXml('0 2 * * *', 'node', 'index.js', 'backup');
    if (!xml.includes('<?xml') || !xml.includes('<Task') || !xml.includes('<Exec>')) {
      throw new Error('Generated XML task scheduler configuration is invalid.');
    }
    logger.info('✅ Test 6 Passed!');

    // ----------------------------------------------------
    // TEST 7: Connection String Parsing
    // ----------------------------------------------------
    logger.info('--- Test 7: Connection String Parsing ---');
    const pgConnStr = 'postgresql://johndoe:mypassword@db.example.com:5432/production_db?sslmode=require';
    const parsedPg = parseConnectionString(pgConnStr);
    if (parsedPg.type !== 'postgres' ||
        parsedPg.host !== 'db.example.com' ||
        parsedPg.port !== 5432 ||
        parsedPg.user !== 'johndoe' ||
        parsedPg.password !== 'mypassword' ||
        parsedPg.name !== 'production_db') {
      throw new Error(`Postgres URI parsing failed: ${JSON.stringify(parsedPg)}`);
    }

    const mysqlConnStr = 'mysql://root:secret@127.0.0.1:3306/mydb';
    const parsedMysql = parseConnectionString(mysqlConnStr);
    if (parsedMysql.type !== 'mysql' ||
        parsedMysql.host !== '127.0.0.1' ||
        parsedMysql.port !== 3306 ||
        parsedMysql.user !== 'root' ||
        parsedMysql.password !== 'secret' ||
        parsedMysql.name !== 'mydb') {
      throw new Error(`MySQL URI parsing failed: ${JSON.stringify(parsedMysql)}`);
    }

    const sqliteFileStr = 'file:./app.db';
    const parsedSqlite = parseConnectionString(sqliteFileStr);
    if (parsedSqlite.type !== 'sqlite' || parsedSqlite.sqliteDbPath !== './app.db') {
      throw new Error(`SQLite URI parsing failed: ${JSON.stringify(parsedSqlite)}`);
    }
    logger.info('✅ Test 7 Passed!');

    // ----------------------------------------------------
    // TEST 8: Multi-Database Configuration and Loop
    // ----------------------------------------------------
    logger.info('--- Test 8: Multi-Database Backup Flow ---');
    const dbPath1 = path.join(sandboxDir, 'mock1.db');
    const dbPath2 = path.join(sandboxDir, 'mock2.db');
    fs.writeFileSync(dbPath1, 'SQLite format 3\u0000Mock database 1 contents', 'utf-8');
    fs.writeFileSync(dbPath2, 'SQLite format 3\u0000Mock database 2 contents', 'utf-8');

    const multiOutDir = path.join(sandboxDir, 'multi-backups');
    const multiConfig = {
      databases: [
        {
          type: 'sqlite' as const,
          sqliteDbPath: dbPath1,
          name: 'auth_service'
        },
        {
          type: 'sqlite' as const,
          sqliteDbPath: dbPath2,
          name: 'orders_service'
        }
      ],
      backup: {
        outputDir: multiOutDir,
        compress: 'none' as const,
        encrypt: false,
        remoteProvider: 'local' as const,
      }
    };

    // Verify sequential backing up of multiple databases
    if (multiConfig.databases && multiConfig.databases.length > 0) {
      for (const db of multiConfig.databases) {
        const singleDbConfig = {
          database: db,
          backup: multiConfig.backup,
        };
        const entry = await runBackup(singleDbConfig);
        if (!fs.existsSync(entry.filePath)) {
          throw new Error(`Multi-db backup failed to create file for: ${db.name}`);
        }
      }
    }

    const manifestMulti = loadManifest(multiOutDir);
    if (manifestMulti.length !== 2) {
      throw new Error(`Expected 2 backups in manifest, found ${manifestMulti.length}`);
    }
    logger.info('✅ Test 8 Passed!');

    // ----------------------------------------------------
    // TEST 9: Pre-restore Integrity Check Failure
    // ----------------------------------------------------
    logger.info('--- Test 9: Pre-Restore Checksum Validation ---');
    const outDir9 = path.join(sandboxDir, 'backups9');
    const config9 = {
      database: {
        type: 'sqlite' as const,
        sqliteDbPath: dbPath,
      },
      backup: {
        outputDir: outDir9,
        compress: 'none' as const,
        encrypt: false,
        remoteProvider: 'local' as const,
      }
    };

    const entry9 = await runBackup(config9);
    const backupFile9 = entry9.filePath;

    // Tamper with the backup file on disk by appending corrupted text
    fs.appendFileSync(backupFile9, 'CORRUPTED DATA STREAM TRAILING CONTENT');

    // Attempt to restore it should fail during the pre-restore checksum check
    let threwChecksumError = false;
    try {
      await runRestore(config9, backupFile9, { dryRun: true });
    } catch (err: any) {
      if (err.message.includes('Pre-restore integrity verification FAILED')) {
        threwChecksumError = true;
        logger.info('Expected integrity verification error caught: ' + err.message);
      } else {
        throw new Error(`Restore failed with unexpected error: ${err.message}`);
      }
    }
    if (!threwChecksumError) {
      throw new Error('Test 9 restoration of tampered file should have failed pre-restore check!');
    }
    logger.info('✅ Test 9 Passed!');

    // ----------------------------------------------------
    // TEST 10: macOS launchd plist Generator
    // ----------------------------------------------------
    logger.info('--- Test 10: macOS plist Template Generation ---');
    const plist = generateMacOsPlist('0 2 * * *', 'node', 'index.js', 'backup');
    if (!plist.includes('<?xml') || !plist.includes('<plist') || !plist.includes('<key>Label</key>') || !plist.includes('<key>StartCalendarInterval</key>')) {
      throw new Error('Generated macOS launchd plist task configuration is invalid.');
    }
    logger.info('✅ Test 10 Passed!');

    logger.info('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! Everything is green! ✅');

  } finally {
    // Cleanup sandbox
    logger.info('Cleaning up test sandbox...');
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  }
}

runIntegrationTests().catch((err) => {
  logger.error('❌ INTEGRATION TEST ERROR: ' + err.message);
  process.exit(1);
});
