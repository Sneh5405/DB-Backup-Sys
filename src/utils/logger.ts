import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Standard console log format
const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

let logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    consoleFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        consoleFormat
      ),
    }),
  ],
});

export function configureLogger(options: { verbose?: boolean; quiet?: boolean; logJson?: boolean }) {
  let level = 'info';
  if (options.verbose) {
    level = 'debug';
  } else if (options.quiet) {
    level = 'error';
  }

  const formats = [
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
  ];

  if (options.logJson) {
    formats.push(winston.format.json());
  } else {
    formats.push(consoleFormat);
  }

  const activeFormat = combine(...formats);

  // Clear existing transports and re-add with new settings
  logger.clear();

  logger.add(
    new winston.transports.Console({
      level,
      format: options.logJson
        ? activeFormat
        : combine(colorize({ all: true }), activeFormat),
    })
  );
}

export default logger;
