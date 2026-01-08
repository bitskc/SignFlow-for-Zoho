/**
 * Rate Limiter Utility
 * 
 * Implements rate limiting for API endpoints to prevent abuse and protect against
 * cascading failures from the Zoho API.
 * 
 * For Vercel Edge Functions, we use a simple approach:
 * - Track requests by user ID (from Supabase auth) or IP address
 * - Use in-memory storage with timestamps
 * - For distributed rate limiting, this should be backed by Vercel KV in production
 */

type RateLimitKey = string;
type RateLimitStore = Map<RateLimitKey, number[]>;

// In-memory store for request timestamps
// In production with multiple regions/invocations, use Vercel KV
const requestTimestamps: RateLimitStore = new Map();

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30, // 30 requests per minute
};

/**
 * Generate a rate limit key from request context
 * Prefers authenticated user ID, falls back to IP address
 */
export function getRateLimitKey(req: Request, userId?: string): string {
  if (userId) {
    return `user:${userId}`;
  }
  // Extract client IP from headers (set by Vercel)
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  return `ip:${ip}`;
}

/**
 * Check if a request is within rate limits
 * @param key The rate limit key (user ID or IP)
 * @param config The rate limit configuration
 * @returns Rate limit result with allowed status and remaining requests
 */
export function checkRateLimit(
  key: RateLimitKey,
  config: RateLimitConfig = DEFAULT_CONFIG
): RateLimitResult {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Get or create timestamps array for this key
  if (!requestTimestamps.has(key)) {
    requestTimestamps.set(key, []);
  }

  const timestamps = requestTimestamps.get(key)!;

  // Remove timestamps outside the current window
  const validTimestamps = timestamps.filter((ts) => ts > windowStart);

  // Check if limit exceeded
  const requestCount = validTimestamps.length;
  const allowed = requestCount < config.maxRequests;

  // Update the store
  validTimestamps.push(now);
  requestTimestamps.set(key, validTimestamps);

  const remaining = Math.max(0, config.maxRequests - requestCount - 1);
  const resetTime = Math.max(...validTimestamps) + config.windowMs;
  const retryAfter = allowed ? undefined : Math.ceil((resetTime - now) / 1000);

  return {
    allowed,
    remaining,
    resetTime,
    retryAfter,
  };
}

/**
 * Create a 429 Too Many Requests response
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Retry-After': result.retryAfter?.toString() || '60',
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
      },
    }
  );
}

/**
 * Extract user ID from Supabase auth token (if present)
 */
export async function getUserIdFromRequest(req: Request): Promise<string | undefined> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return undefined;
  }

  // Note: Full JWT parsing would require a library
  // For now, we just use the header as part of the key
  // In production, validate and extract the actual user ID
  const token = authHeader.slice('Bearer '.length);
  return token.slice(0, 20); // Use first 20 chars as pseudo-ID
}

/**
 * Per-endpoint rate limit configurations
 */
export const RATE_LIMITS = {
  // Zoho API endpoint - more restrictive
  ZOHO_API: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 20, // 20 requests per minute
  },
  // Credentials management
  CREDENTIALS: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10, // 10 requests per minute
  },
  // Forms endpoint
  FORMS: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30, // 30 requests per minute
  },
  // Subscription checks
  SUBSCRIPTION: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    maxRequests: 20, // 20 requests per 5 minutes
  },
};

/**
 * Clean up old entries from the store (call periodically)
 * Prevents unbounded memory growth
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // Keep entries for max 10 minutes

  for (const [key, timestamps] of requestTimestamps.entries()) {
    const validTimestamps = timestamps.filter((ts) => now - ts < maxAge);
    if (validTimestamps.length === 0) {
      requestTimestamps.delete(key);
    } else {
      requestTimestamps.set(key, validTimestamps);
    }
  }
}
