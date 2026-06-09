import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  remoteDir: string;
}

/**
 * Uploads a local file to a remote SFTP server using fastPut.
 */
export function uploadToSftp(filePath: string, fileName: string, config: SftpConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const remotePath = path.posix.join(config.remoteDir, fileName);
        logger.info(`Uploading ${fileName} to SFTP server ${config.host}:${config.remoteDir}...`);

        let lastPercent = 0;
        sftp.fastPut(filePath, remotePath, {
          step: (totalTransferred, chunk, total) => {
            const percentage = Math.round((totalTransferred / total) * 100);
            if (percentage >= lastPercent + 10 || percentage === 100) {
              logger.info(`SFTP Upload Progress: ${percentage}% (${totalTransferred}/${total} bytes)`);
              lastPercent = percentage;
            }
          }
        }, (putErr) => {
          conn.end();
          if (putErr) {
            reject(putErr);
          } else {
            logger.info(`SFTP Upload successful: ${remotePath}`);
            resolve(`sftp://${config.host}/${remotePath}`);
          }
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    const connOpts: any = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
    };

    if (config.privateKey) {
      connOpts.privateKey = config.privateKey;
    } else if (config.password) {
      connOpts.password = config.password;
    }

    conn.connect(connOpts);
  });
}
