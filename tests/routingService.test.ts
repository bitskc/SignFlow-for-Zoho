import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSubdomainType, getRouteContext, buildFormUrl } from '../services/routingService';

// Helper to mock window.location in a controlled way
function mockLocation(url: string) {
  const loc = new URL(url);
  // @ts-ignore
  delete global.window.location;
  // @ts-ignore
  global.window.location = {
    href: loc.href,
    protocol: loc.protocol,
    hostname: loc.hostname,
    port: loc.port,
    pathname: loc.pathname,
    search: loc.search,
    hash: loc.hash,
  } as any;
}

describe('routingService.getSubdomainType', () => {
  it('detects root domain', () => {
    expect(getSubdomainType('signflow.ink')).toBe('root');
  });

  it('detects www subdomain', () => {
    expect(getSubdomainType('www.signflow.ink')).toBe('www');
  });

  it('detects app subdomain', () => {
    expect(getSubdomainType('app.signflow.ink')).toBe('app');
  });

  it('treats localhost as www by default', () => {
    expect(getSubdomainType('localhost')).toBe('www');
  });
});

describe('routingService.getRouteContext', () => {
  beforeEach(() => {
    // @ts-ignore
    global.window = global.window || {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes a clean form slug on www', () => {
    mockLocation('https://www.signflow.ink/fbmc');
    const ctx = getRouteContext();
    expect(ctx.subdomain).toBe('www');
    expect(ctx.isFormSlug).toBe(true);
    expect(ctx.formSlug).toBe('fbmc');
  });

  it('does not treat /api paths as slugs', () => {
    mockLocation('https://www.signflow.ink/api/health');
    const ctx = getRouteContext();
    expect(ctx.isFormSlug).toBe(false);
    expect(ctx.formSlug).toBeNull();
  });
});

describe('routingService.buildFormUrl', () => {
  beforeEach(() => {
    // @ts-ignore
    global.window = global.window || {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns www host for production domains', () => {
    mockLocation('https://app.signflow.ink/fbmc');
    const url = buildFormUrl('fbmc');
    expect(url).toBe('https://www.signflow.ink/fbmc');
  });

  it('preserves localhost and port in dev', () => {
    mockLocation('http://localhost:5173/fbmc');
    const url = buildFormUrl('fbmc');
    expect(url).toBe('http://localhost:5173/fbmc');
  });
});
