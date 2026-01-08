import { supabaseServer } from './_supabaseServer';
import { createRequestLogger, sanitizeLogContext } from './utils/logger';
import { 
  getRateLimitKey, 
  checkRateLimit, 
  createRateLimitResponse, 
  RATE_LIMITS,
  cleanupRateLimitStore 
} from './utils/rateLimiter';

export const config = { runtime: 'edge' };

async function getUserFromAuthHeader(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const { data, error } = await supabaseServer.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export default async function handler(req: Request) {
  const { requestId, logger, logResponse, logError } = createRequestLogger(req);

  // Periodic cleanup
  if (Math.random() < 0.01) {
    cleanupRateLimitStore();
  }

  try {
    const user = await getUserFromAuthHeader(req);
    if (!user) {
      logger.warn('Unauthorized access attempt');
      logResponse(401);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    logger.debug('User authenticated', { userId: user.id });

    // Apply rate limiting
    const rateLimitKey = getRateLimitKey(req, user.id);
    const rateLimitCheck = checkRateLimit(rateLimitKey, RATE_LIMITS.CREDENTIALS);
    
    if (!rateLimitCheck.allowed) {
      logger.warn('Rate limit exceeded for credentials endpoint', {
        limitKey: rateLimitKey,
        retryAfter: rateLimitCheck.retryAfter,
      });
      return createRateLimitResponse(rateLimitCheck);
    }

    const table = 'user_credentials';

    if (req.method === 'GET') {
      logger.debug('Fetching user credentials');
      const { data, error } = await supabaseServer
        .from(table)
        .select('zoho_client_id,zoho_client_secret,zoho_refresh_token,api_domain')
        .eq('user_id', user.id)
        .maybeSingle();
      
      if (error) {
        logger.error('Database error fetching credentials', error);
        logResponse(400, { reason: 'db_error' });
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
      }
      
      if (!data) {
        logger.info('No credentials found for user');
        logResponse(404);
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      logger.info('Credentials retrieved successfully');
      logResponse(200);
      return new Response(JSON.stringify({
        clientId: data.zoho_client_id,
        clientSecret: data.zoho_client_secret,
        refreshToken: data.zoho_refresh_token,
        apiDomain: data.api_domain
      }), { status: 200 });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      logger.debug('Updating user credentials', sanitizeLogContext({
        clientIdProvided: !!req.body,
        apiDomain: (await req.json()).apiDomain,
      }));

      const body = await req.json();
      const record = {
        user_id: user.id,
        zoho_client_id: body.clientId,
        zoho_client_secret: body.clientSecret,
        zoho_refresh_token: body.refreshToken,
        api_domain: body.apiDomain || 'https://sign.zoho.com'
      };

      const { data, error } = await supabaseServer
        .from(table)
        .upsert(record, { onConflict: 'user_id' })
        .select()
        .maybeSingle();
      
      if (error) {
        logger.error('Database error updating credentials', error);
        logResponse(400, { reason: 'db_error' });
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
      }

      logger.info('Credentials updated successfully');
      logResponse(200);
      return new Response(JSON.stringify({
        clientId: data?.zoho_client_id,
        clientSecret: data?.zoho_client_secret,
        refreshToken: data?.zoho_refresh_token,
        apiDomain: data?.api_domain
      }), { status: 200 });
    }

    logger.warn('Method not allowed', { method: req.method });
    logResponse(405);
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  } catch (error) {
    logError(error, 500);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: (error as Error).message
    }), { status: 500 });
  }
