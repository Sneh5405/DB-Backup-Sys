import cron from 'node-cron';
import { AppConfig } from '../utils/config.js';
import { runBackup } from '../backup-engine.js';
import logger from '../utils/logger.js';

/**
 * Starts a built-in scheduler using node-cron.
 */
export function startScheduler(config: AppConfig, cronExpression: string): void {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression: "${cronExpression}". See https://crontab.guru for reference.`);
  }

  logger.info(`Starting built-in database backup scheduler...`);
  logger.info(`Cron expression: "${cronExpression}"`);
  logger.info(`Press Ctrl+C to stop the scheduler.`);

  // Schedule the job
  const job = cron.schedule(cronExpression, async () => {
    logger.info('Scheduled backup job triggered.');
    try {
      await runBackup(config);
    } catch (err: any) {
      logger.error(`Scheduled backup job failed: ${err.message}`);
    }
  });

  job.start();
}
