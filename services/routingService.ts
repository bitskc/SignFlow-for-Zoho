export type SubdomainType = 'root' | 'www' | 'app' | 'unknown';

export interface RouteContext {
  subdomain: SubdomainType;
  pathname: string;
  search: string;
  hash: string;
  isFormSlug: boolean;
  formSlug: string | null;
}

export function getSubdomainType(hostname: string): SubdomainType {
  // Local development: treat localhost as www by default, with optional ?subdomain overrides
  if (hostname === 'localhost' || hostname.startsWith('127.0.0.1')) {
    try {
      const params = new URLSearchParams(window.location.search);
      const sub = params.get('subdomain');
      if (sub === 'app') return 'app';
      if (sub === 'www') return 'www';
      return 'www';
    } catch {
      return 'www';
    }
  }

  if (hostname.startsWith('app.')) return 'app';
  if (hostname.startsWith('www.')) return 'www';

  const parts = hostname.split('.');
  if (parts.length === 2) {
    // e.g., signflow.ink
    return 'root';
  }

  return 'unknown';
}

export function getRouteContext(): RouteContext {
  const { hostname, pathname, search, hash } = window.location;
  const subdomain = getSubdomainType(hostname);

  const cleanPath = pathname.substring(1).replace(/\/$/, '');
  const isFormSlug = Boolean(
    cleanPath &&
      !cleanPath.startsWith('api') &&
      /^[a-z0-9-]+$/.test(cleanPath)
  );

  return {
    subdomain,
    pathname,
    search,
    hash,
    isFormSlug,
    formSlug: isFormSlug ? cleanPath : null,
  };
}

export function buildFormUrl(slug: string): string {
  const { protocol, hostname, port } = window.location;

  // Local dev: keep current host/port
  if (hostname === 'localhost' || hostname.startsWith('127.0.0.1')) {
    const base = `${protocol}//${hostname}${port ? `:${port}` : ''}`;
    return `${base}/${slug}`;
  }

  // Strip leading app./www. to get bare domain
  const baseDomain = hostname.replace(/^(www\.|app\.)/, '');
  return `${protocol}//www.${baseDomain}/${slug}`;
}
