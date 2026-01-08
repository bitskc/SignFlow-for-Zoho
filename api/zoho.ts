import { supabaseServer } from './_supabaseServer';
import { createRequestLogger, sanitizeLogContext } from './utils/logger';
import { 
  getRateLimitKey, 
  checkRateLimit, 
  createRateLimitResponse, 
  RATE_LIMITS,
  cleanupRateLimitStore 
} from './utils/rateLimiter';

export const config = {
  runtime: 'edge',
};

/**
 * Maps the API domain to the correct Zoho Accounts URL for OAuth
 */
function getAccountsUrl(apiDomain: string) {
  if (apiDomain.includes('.eu')) return 'https://accounts.zoho.eu';
  if (apiDomain.includes('.in')) return 'https://accounts.zoho.in';
  if (apiDomain.includes('.com.au')) return 'https://accounts.zoho.com.au';
  if (apiDomain.includes('.jp')) return 'https://accounts.zoho.jp';
  return 'https://accounts.zoho.com';
}

async function getOAuthToken(params: URLSearchParams, apiDomain: string) {
  const accountsUrl = `${getAccountsUrl(apiDomain)}/oauth/v2/token`;

  const response = await fetch(accountsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: params,
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'OAuth Request Failed');
  }
  return data;
}

export default async function handler(req: Request) {
  const { requestId, logger, logResponse, logError } = createRequestLogger(req);
  
  // Periodic cleanup (every 100th request)
  if (Math.random() < 0.01) {
    cleanupRateLimitStore();
  }

  if (req.method !== 'POST') {
    logResponse(405);
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { action, apiDomain, clientId, clientSecret, refreshToken, grantToken, redirectUri, userId } = body;
    
    logger.debug('Request body received', sanitizeLogContext({
      action,
      apiDomain,
      clientId: clientId ? '[PROVIDED]' : '[ENV]',
      clientSecret: clientSecret ? '[PROVIDED]' : '[ENV]',
      userId: userId ? '[PROVIDED]' : undefined,
      templateId: body.templateId?.slice(0, 8),
    }));

    // Apply rate limiting
    const rateLimitKey = getRateLimitKey(req, userId);
    const rateLimitCheck = checkRateLimit(rateLimitKey, RATE_LIMITS.ZOHO_API);
    
    if (!rateLimitCheck.allowed) {
      logger.warn('Rate limit exceeded', {
        limitKey: rateLimitKey,
        retryAfter: rateLimitCheck.retryAfter,
      });
      return createRateLimitResponse(rateLimitCheck);
    }

    const resolvedClientId = clientId || process.env.ZOHO_CLIENT_ID;
    const resolvedClientSecret = clientSecret || process.env.ZOHO_CLIENT_SECRET;

    // --- CASE 1: Initial OAuth Exchange (Grant Token -> Refresh Token) ---
    if (action === 'exchange') {
      logger.info('Processing OAuth token exchange');
      
      const params = new URLSearchParams();
      params.append('code', grantToken);
      params.append('client_id', resolvedClientId || '');
      params.append('client_secret', resolvedClientSecret || '');
      // The redirect_uri MUST match the one used to generate the code originally
      params.append('redirect_uri', redirectUri || 'https://api-console.zoho.com');
      params.append('grant_type', 'authorization_code');
      
      try {
        const data = await getOAuthToken(params, apiDomain || 'sign.zoho.com');
        logger.info('OAuth token exchange successful');
        logResponse(200, { action: 'exchange' });
        return new Response(JSON.stringify(data), { status: 200 });
      } catch (e: any) {
        logger.error('OAuth token exchange failed', e);
        logResponse(400, { action: 'exchange' });
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    // --- CASE 2: Standard Sign Request ---
    const { templateId, signer, roleName, isTest, accessToken: providedAccessToken, clientId: providedClientId, clientSecret: providedClientSecret } = body;

    let effectiveClientId = providedClientId || resolvedClientId;
    let effectiveClientSecret = providedClientSecret || resolvedClientSecret;
    let effectiveRefreshToken = refreshToken;
    let effectiveApiDomain = apiDomain;

    logger.debug('Resolving credentials', {
      clientIdProvided: !!providedClientId,
      refreshTokenProvided: !!refreshToken,
      userId: userId ? '[PROVIDED]' : undefined,
    });

    // If creds not provided, try to load from Supabase by userId
    if ((!effectiveClientId || !effectiveClientSecret || !effectiveRefreshToken) && userId) {
      logger.debug('Loading credentials from Supabase', { userId });
      const { data: credRow, error: credErr } = await supabaseServer
        .from('user_credentials')
        .select('zoho_client_id,zoho_client_secret,zoho_refresh_token,api_domain')
        .eq('user_id', userId)
        .maybeSingle();
      if (credErr) {
        logger.error('Failed to load credentials from Supabase', credErr);
      } else if (credRow) {
        logger.info('Credentials loaded from Supabase');
        effectiveClientId = effectiveClientId || credRow.zoho_client_id;
        effectiveClientSecret = effectiveClientSecret || credRow.zoho_client_secret;
        effectiveRefreshToken = effectiveRefreshToken || credRow.zoho_refresh_token;
        effectiveApiDomain = effectiveApiDomain || credRow.api_domain;
      }
    }

    if (!providedAccessToken && (!effectiveClientId || !effectiveClientSecret || !effectiveRefreshToken)) {
      const errorMsg = 'Missing credentials: clientId/clientSecret must be set on the server and refreshToken provided unless you pass accessToken.';
      logger.error(errorMsg);
      logResponse(400, { reason: 'missing_credentials' });
      return new Response(JSON.stringify({ 
        error: 'Missing credentials', 
        message: errorMsg 
      }), { status: 400 });
    }
    if (!templateId || !signer?.name || !signer?.email) {
      const missingFields = [
        !templateId && 'templateId',
        !signer?.name && 'signer.name',
        !signer?.email && 'signer.email'
      ].filter(Boolean);
      const errorMsg = `Missing required fields: ${missingFields.join(', ')}`;
      logger.error(errorMsg);
      logResponse(400, { reason: 'missing_fields', missingFields });
      return new Response(JSON.stringify({ 
        error: 'Missing data', 
        message: errorMsg
      }), { status: 400 });
    }

    const cleanDomain = (effectiveApiDomain || 'https://sign.zoho.com').replace(/\/+$/, '').trim();
    const cleanTemplateId = (templateId || '').trim();
    const cleanRoleName = (roleName || "Signer 1").trim();
    
    logger.debug('Request parameters validated', {
      templateId: cleanTemplateId.slice(0, 8),
      roleName: cleanRoleName,
      domain: cleanDomain,
      signerEmail: signer.email,
    });
    
    let accessToken: string | undefined = providedAccessToken;
    if (!accessToken) {
      logger.debug('Refreshing access token');
      const refreshParams = new URLSearchParams();
      refreshParams.append('refresh_token', effectiveRefreshToken);
      refreshParams.append('client_id', effectiveClientId || '');
      refreshParams.append('client_secret', effectiveClientSecret || '');
      refreshParams.append('grant_type', 'refresh_token');

      try {
        const authData = await getOAuthToken(refreshParams, cleanDomain);
        accessToken = authData.access_token;
        logger.info('Access token refreshed successfully');
      } catch (authError: any) {
        logger.error('Token refresh failed', authError);
        logResponse(401, { reason: 'auth_failure', error: authError.message });
        return new Response(JSON.stringify({ 
          error: 'Authentication Failure', 
          message: authError.message,
          hint: "Your Refresh Token might be invalid or your Client ID/Secret do not match."
        }), { status: 401 });
      }
    }

    // Fetch template to resolve the correct action_id for the requested role
    logger.debug('Fetching template metadata', { templateId: cleanTemplateId });
    const templateInfo = await fetch(`${cleanDomain}/api/v1/templates/${cleanTemplateId}`, {
      method: 'GET',
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    });
    if (!templateInfo.ok) {
      const txt = await templateInfo.text();
      logger.error('Template fetch failed', { status: templateInfo.status, response: txt });
      logResponse(400, { reason: 'template_fetch_failed' });
      return new Response(JSON.stringify({ error: 'Template fetch failed', message: txt }), { status: 400 });
    }
    const templateData = await templateInfo.json();
    const actions = templateData?.templates?.actions || [];
    logger.debug('Template metadata retrieved', { 
      templateId: cleanTemplateId,
      availableRoles: actions.map((a: any) => a.role)
    });
    
    const matchedAction = actions.find((a: any) => (a.role || '').trim().toLowerCase() === cleanRoleName.toLowerCase());
    if (!matchedAction?.action_id) {
      const errorMsg = `Role '${cleanRoleName}' not found in template ${cleanTemplateId}. Available roles: ${actions.map((a: any) => a.role).join(', ')}`;
      logger.warn('Role mismatch', { requestedRole: cleanRoleName, availableRoles: actions.map((a: any) => a.role) });
      logResponse(400, { reason: 'role_not_found' });
      return new Response(JSON.stringify({
        error: 'Role not found',
        message: errorMsg
      }), { status: 400 });
    }

    const endpoint = `${cleanDomain}/api/v1/templates/${cleanTemplateId}/createdocument`;

    logger.debug('Creating Zoho Sign document', { 
      templateId: cleanTemplateId, 
      role: cleanRoleName,
      signerName: signer.name
    });

    const payload = {
      templates: {
        request_name: isTest ? `TEST - ${new Date().toLocaleTimeString()}` : `Signature Request - ${signer.name}`,
        actions: [
          {
            recipient_name: signer.name,
            recipient_email: signer.email,
            action_type: "SIGN",
            action_id: matchedAction.action_id,
            role: matchedAction.role,
            verify_recipient: false,
            // embedded signing typically suppresses Zoho emails; we still surface the signing_url to open directly
            is_embedded: true
          }
        ],
        field_data: {
          field_text_data: {
             "Signer Name": signer.name,
             "Full Name": signer.name,
             "Name": signer.name
          }
        },
        notes: "Generated via SignFlow Pro - direct link"
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      logger.error('Failed to parse Zoho API response', { responseText });
      data = { error: "Non-JSON Response", raw: responseText };
    }
    
    if (response.status === 400 && responseText.includes("action_id")) {
      data.debug_hint = `Role '${cleanRoleName}' was not found in template ${cleanTemplateId}.`;
    }

    if (!response.ok) {
      logger.error('Zoho document creation failed', { 
        status: response.status, 
        error: data.error,
        message: data.message 
      });
      logResponse(response.status, { reason: 'zoho_api_error' });
      return new Response(JSON.stringify(data), { status: response.status });
    }

    logger.info('Zoho document created successfully', {
      requestId: data?.requests?.request_id,
      templateId: cleanTemplateId
    });

    // For embedded signing, make the embedtoken API call to get the proper signing URL
    if (response.ok && data.requests) {
      const request = data.requests;
      const actions = request?.actions || [];
      const action = actions[0];
      
      if (action?.action_id && request?.request_id) {
        try {
          logger.debug('Fetching embed token for embedded signing', {
            requestId: request.request_id,
            actionId: action.action_id
          });
          
          const host = req.headers.get('origin') || 'https://zoho-sign-forms.vercel.app';
          const embedUrl = `${cleanDomain}/api/v1/requests/${request.request_id}/actions/${action.action_id}/embedtoken?host=${host}`;
          
          const embedResponse = await fetch(embedUrl, {
            method: 'GET',
            headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
          });
          
          if (embedResponse.ok) {
            const embedData = await embedResponse.json();
            logger.debug('Embed token received', { hasSignUrl: !!embedData.sign_url });
            // Update the action with the embed signing URL
            if (embedData.sign_url) {
              action.signing_url = embedData.sign_url;
              logger.info('Signing URL updated from embed token');
            }
          } else {
            logger.warn('Embed token request failed', { status: embedResponse.status });
          }
        } catch (embedError) {
          logger.error('Error fetching embed token', embedError);
        }
      }
    }

    logResponse(response.status, {
      requestId: data?.requests?.request_id,
      hasSigningUrl: !!data?.requests?.actions?.[0]?.signing_url
    });

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    logError(error, 500);
