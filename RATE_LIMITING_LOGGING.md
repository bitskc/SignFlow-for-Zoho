## Rate Limiting & Structured Logging Implementation

### Overview
This implementation adds two critical production-ready features to the Zoho Sign Forms API:
1. **Rate Limiting** - Protects against abuse and cascading failures
2. **Structured Logging** - Enables debugging and log aggregation

---

## Rate Limiting (`api/utils/rateLimiter.ts`)

### Key Features
- **Distributed-ready design**: Uses per-request-scoped tracking (ready for Vercel KV migration)
- **User-aware**: Prioritizes authenticated user ID, falls back to IP address
- **Configurable per-endpoint**: Different limits for different API endpoints
- **Memory cleanup**: Automatic cleanup of old entries to prevent unbounded growth

### Rate Limit Configs
```typescript
ZOHO_API: 20 requests per minute       // More restrictive
CREDENTIALS: 10 requests per minute    // Authentication-critical
FORMS: 30 requests per minute          // Public forms
SUBSCRIPTION: 20 requests per 5 min    // Less frequent
```

### Implementation Details
- Tracks request timestamps in a Map
- Removes expired timestamps outside the window
- Returns `429 Too Many Requests` with `Retry-After` header
- Includes `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers

---

## Structured Logging (`api/utils/logger.ts`)

### Key Features
- **JSON output**: All logs are JSON-formatted for log aggregation tools
- **Request IDs**: Unique ID for tracing requests across services
- **Log levels**: DEBUG, INFO, WARN, ERROR with appropriate formatting
- **Sensitive data redaction**: Automatically redacts passwords, tokens, secrets
- **Request context**: Captures method, endpoint, status code, duration

### Log Format
```json
{
  "timestamp": "2026-01-07T12:34:56.789Z",
  "level": "ERROR",
  "message": "Token refresh failed",
  "context": {
    "requestId": "1234567890-abc123",
    "userId": "user-123",
    "endpoint": "/api/zoho",
    "method": "POST",
    "duration": 1234
  },
  "error": {
    "name": "Error",
    "message": "Invalid refresh token",
    "stack": "Error: Invalid refresh token\n    at ..."
  }
}
```

### Integration Points
- **createRequestLogger**: Main entry point for all API handlers
  - Logs request entry/exit
  - Captures timing information
  - Provides `logResponse()` and `logError()` helpers

- **Automatic sensitive field redaction** for:
  - password, clientSecret, refreshToken, accessToken
  - token, secret, key, authorization

---

## API Handler Updates

### `api/zoho.ts`
- Rate limiting applied before processing
- Logs OAuth token exchanges
- Logs template fetch, role validation, document creation
- Logs embed token generation
- Improved error messages with context
- All `console.log` statements replaced with structured logging

### `api/credentials.ts`
- Rate limiting on all credential operations
- Logs authentication attempts
- Logs credential fetch/update operations
- Sensitive data automatically redacted
- All errors include database context

---

## Monitoring & Debugging

### Request Tracing
Every request gets a unique ID that appears in all related logs:
```
Request received → Credential check → Zoho API calls → Response logged
All tied together with same requestId
```

### Error Context
Errors include:
- What operation failed (exchange, template fetch, document creation, etc.)
- HTTP status codes
- Duration to identify slow operations
- Specific error messages from Zoho API

### Performance Metrics
Each request log includes:
- `duration`: milliseconds from start to response
- `statusCode`: HTTP response status
- `method`: HTTP method (GET, POST, etc.)
- `endpoint`: API path

---

## Production Considerations

### Memory Management
- Rate limit store is cleaned up periodically (1% of requests)
- Old entries (>10 minutes) are automatically removed
- For high-traffic scenarios, migrate to Vercel KV:
  ```typescript
  // Placeholder for future Vercel KV integration
  import { kv } from '@vercel/kv';
  ```

### Log Aggregation
JSON logs are ready for:
- Vercel Analytics
- DataDog
- Splunk
- CloudWatch
- Any JSON-compatible log service

### Rate Limit Tuning
Adjust `RATE_LIMITS` object in `api/utils/rateLimiter.ts`:
- Decrease `maxRequests` to be more restrictive
- Increase `windowMs` for longer rate limit windows
- Per-user limits prevent single user DoS

---

## Example Logs

### Successful Request
```json
{"timestamp":"2026-01-07T12:34:56.789Z","level":"INFO","message":"Request received","context":{"requestId":"1234567890-abc123","method":"POST","endpoint":"/api/zoho"}}
{"timestamp":"2026-01-07T12:34:56.890Z","level":"INFO","message":"OAuth token exchange successful","context":{"requestId":"1234567890-abc123"}}
{"timestamp":"2026-01-07T12:34:57.123Z","level":"INFO","message":"Request completed","context":{"requestId":"1234567890-abc123","statusCode":200,"duration":334}}
```

### Rate Limited Request
```json
{"timestamp":"2026-01-07T12:35:00.000Z","level":"WARN","message":"Rate limit exceeded","context":{"requestId":"9876543210-xyz789","retryAfter":45}}
```

### Error with Context
```json
{"timestamp":"2026-01-07T12:36:00.000Z","level":"ERROR","message":"Token refresh failed","context":{"requestId":"5555555555-err1","statusCode":401,"duration":450},"error":{"name":"Error","message":"Invalid refresh token"}}
```
