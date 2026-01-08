/**
 * Structured Logging Utility
 * 
 * Provides JSON-formatted logging with request tracking, timestamps, and severity levels.
 * Replaces console.log with structured output suitable for log aggregation services.
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  duration?: number;
  [key: string]: any;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a structured logger instance
 */
export function createLogger(context?: LogContext) {
  const baseContext = { ...context };

  const formatError = (error: Error | unknown) => {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    return {
      name: 'Unknown',
      message: String(error),
    };
  };

  const log = (level: LogLevel, message: string, additionalContext?: LogContext | Error) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: baseContext,
    };

    if (additionalContext instanceof Error) {
      entry.error = formatError(additionalContext);
    } else if (additionalContext) {
      entry.context = { ...entry.context, ...additionalContext };
    }

    // Output as JSON for log aggregation
    console.log(JSON.stringify(entry));
  };

  return {
    debug: (message: string, context?: LogContext | Error) =>
      log(LogLevel.DEBUG, message, context),
    info: (message: string, context?: LogContext | Error) =>
      log(LogLevel.INFO, message, context),
    warn: (message: string, context?: LogContext | Error) =>
      log(LogLevel.WARN, message, context),
    error: (message: string, context?: LogContext | Error) =>
      log(LogLevel.ERROR, message, context),
  };
}

/**
 * Create a logger middleware for Vercel Edge Functions
 * Logs request entry/exit with timing information
 */
export function createRequestLogger(req: Request) {
  const requestId = generateRequestId();
  const method = req.method;
  const pathname = new URL(req.url).pathname;
  const startTime = Date.now();

  const logger = createLogger({
    requestId,
    method,
    endpoint: pathname,
  });

  logger.info('Request received', {
    url: req.url,
    headers: {
      'user-agent': req.headers.get('user-agent') || 'unknown',
      'content-type': req.headers.get('content-type') || 'unknown',
    },
  });

  const logResponse = (statusCode: number, additionalContext?: LogContext) => {
    const duration = Date.now() - startTime;
    logger.info('Request completed', {
      statusCode,
      duration,
      ...additionalContext,
    });
  };

  const logError = (error: Error | unknown, statusCode: number = 500) => {
    const duration = Date.now() - startTime;
    logger.error('Request failed', {
      statusCode,
      duration,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  };

  return {
    requestId,
    logger,
    logResponse,
    logError,
  };
}

/**
 * Sanitize sensitive data from logs
 */
export function sanitizeLogContext(context: LogContext): LogContext {
  const sensitiveFields = [
    'password',
    'clientSecret',
    'refreshToken',
    'accessToken',
    'token',
    'secret',
    'key',
    'authorization',
  ];

  const sanitized = { ...context };

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}
