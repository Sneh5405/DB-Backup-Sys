import logger from './logger.js';

export interface SlackNotificationConfig {
  webhookUrl: string;
}

/**
 * Sends a notification message to a Slack Webhook URL.
 */
export async function sendSlackNotification(
  webhookUrl: string,
  status: 'success' | 'failed',
  message: string,
  details: {
    dbType: string;
    dbName: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
  }
): Promise<void> {
  if (!webhookUrl) {
    return;
  }

  const isSuccess = status === 'success';
  const color = isSuccess ? '#2eb886' : '#a30200'; // Green or Red
  const title = isSuccess ? '🟢 Database Backup Succeeded' : '🔴 Database Backup Failed';

  const attachment: any = {
    color,
    title,
    text: message,
    fields: [
      { title: 'Database Type', value: details.dbType, short: true },
      { title: 'Database Name', value: details.dbName, short: true },
    ],
    ts: Math.floor(Date.now() / 1000),
  };

  if (isSuccess && details.fileName) {
    attachment.fields.push({ title: 'Backup File', value: details.fileName, short: false });
    if (details.fileSize !== undefined) {
      const sizeMb = (details.fileSize / (1024 * 1024)).toFixed(2);
      attachment.fields.push({ title: 'Size', value: `${sizeMb} MB (${details.fileSize} bytes)`, short: true });
    }
  } else if (!isSuccess && details.error) {
    attachment.fields.push({ title: 'Error Detail', value: `\`\`\`${details.error}\`\`\``, short: false });
  }

  const payload = {
    attachments: [attachment],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error status: ${response.status}`);
    }

    logger.debug('Slack notification sent successfully.');
  } catch (err: any) {
    logger.error(`Failed to send Slack notification: ${err.message}`);
  }
}
export async function sendNotification(
  webhookUrl: string | undefined,
  status: 'success' | 'failed',
  message: string,
  details: {
    dbType: string;
    dbName: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
  }
): Promise<void> {
  if (webhookUrl) {
    await sendSlackNotification(webhookUrl, status, message, details);
  }
}
