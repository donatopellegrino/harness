import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class ChatGPTAuth {
  constructor(store, { fetcher = fetch, discovery, jwks } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.discovery = discovery;
    this.jwks = jwks;
    this.profile = store.read('auth.json', null);
    this.host = store.read('host.json', null) ?? { id: `urn:uuid:${randomUUID()}` };
    store.write('host.json', this.host);
    this.pending = null;
    this.refreshing = null;
    this.generation = 0;
  }
  async metadata() {
    if (!this.discovery) {
      const response = await this.fetcher('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Could not load ChatGPT sign-in configuration.');
      const metadata = await response.json();
      if (metadata.issuer !== 'https://auth.openai.com' || ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint'].some(key => new URL(metadata[key]).origin !== 'https://auth.openai.com')) {
        throw new Error('Unexpected ChatGPT sign-in configuration.');
      }
      this.discovery = metadata;
    }
    this.jwks ??= createRemoteJWKSet(new URL(this.discovery.jwks_uri));
    return this.discovery;
  }
  status() {
    return {
      connected: Boolean(this.profile?.access_token),
      sharing: Boolean(this.profile?.access_token && this.profile.scope?.split(' ').includes('chatgpt.tokens.use.direct')),
      email: this.profile?.email ?? null,
    };
  }
  async begin(origin) {
    const metadata = await this.metadata();
    const state = random(), nonce = random(), verifier = random();
    const clientId = this.profile?.client_id;
    const redirect = `${origin}/auth/callback`;
    this.pending = { state, nonce, verifier, redirect, clientId, generation: this.generation, expires: Date.now() + 10 * 60 * 1000 };
    const parameters = new URLSearchParams({
      client_id: clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: this.host.id,
      response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (!clientId) parameters.set('agent_name_hint', 'Basic Harness');
    // Request consent again only when the user explicitly reconnects without plan permission.
    if (clientId && !this.status().sharing) parameters.set('prompt', 'consent');
    if (this.profile?.id_token) parameters.set('id_token_hint', this.profile.id_token);
    if (this.profile?.email) parameters.set('login_hint', this.profile.email);
    return `${metadata.authorization_endpoint}?${parameters}`;
  }
  async token(parameters) {
    const metadata = await this.metadata();
    const response = await this.fetcher(metadata.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, resource: RESOURCE }), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`ChatGPT authentication failed (${response.status}). Please sign in again.`);
      error.code = typeof data.error === 'string' ? data.error : data.error?.code;
      throw error;
    }
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('ChatGPT returned an incomplete token response.');
    return data;
  }
  async finish(parameters) {
    const attempt = this.pending;
    if (!attempt || attempt.expires < Date.now() || !equal(parameters.get('state'), attempt.state)) throw new Error('Sign-in expired or state did not match. Start sign-in again.');
    this.pending = null; // A callback can be used only once.
    if (parameters.has('error')) throw new Error('ChatGPT sign-in was declined.');
    if (!parameters.get('code')) throw new Error('ChatGPT did not return an authorization code.');
    const callbackId = parameters.get('client_id');
    const clientId = attempt.clientId ?? callbackId;
    if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && callbackId && callbackId !== attempt.clientId)) throw new Error('ChatGPT returned an invalid client registration.');
    // Retain the registration even if code exchange fails. Never reuse a consumed code.
    if (!attempt.clientId) {
      this.profile = { client_id: clientId };
      this.store.write('auth.json', this.profile);
    }
    const tokens = await this.token({ grant_type: 'authorization_code', client_id: clientId, code: parameters.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirect });
    const metadata = await this.metadata();
    const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
      issuer: metadata.issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5,
    });
    if (!equal(payload.nonce, attempt.nonce) || typeof payload.sub !== 'string' || !payload.sub) throw new Error('ChatGPT identity validation failed.');
    if (this.profile?.sub && this.profile.sub !== payload.sub) throw new Error('This registration belongs to a different ChatGPT account.');
    if (attempt.generation !== this.generation) throw new Error('Sign-in was cancelled.');
    this.profile = {
      client_id: clientId, sub: payload.sub, email: payload.email ?? null,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, scope: tokens.scope ?? '', expires_at: Date.now() + tokens.expires_in * 1000,
    };
    this.store.write('auth.json', this.profile);
    return this.status();
  }
  async accessToken() {
    if (!this.status().sharing) throw new Error('Continue with ChatGPT and allow ChatGPT plan usage first.');
    if (this.profile.expires_at > Date.now() + 60000) return this.profile.access_token;
    if (!this.refreshing) {
      const profile = this.profile, generation = this.generation;
      this.refreshing = (async () => {
        if (!profile.refresh_token) throw new Error('Your ChatGPT session expired. Sign in again.');
        try {
          const tokens = await this.token({ grant_type: 'refresh_token', client_id: profile.client_id, refresh_token: profile.refresh_token });
          if (generation !== this.generation) throw new Error('The ChatGPT session changed.');
          this.profile = { ...profile, access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? profile.refresh_token, scope: tokens.scope ?? profile.scope, expires_at: Date.now() + tokens.expires_in * 1000 };
          this.store.write('auth.json', this.profile);
          if (!this.status().sharing) throw new Error('ChatGPT plan usage is no longer authorized. Sign in again.');
          return this.profile.access_token;
        } catch (error) {
          if (generation === this.generation && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) this.clearTokens();
          throw error;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  clearTokens() {
    this.profile = this.profile ? { client_id: this.profile.client_id, sub: this.profile.sub, email: this.profile.email } : null;
    this.store.write('auth.json', this.profile);
  }
  async logout() {
    // Complete any rotating refresh before revoking its replacement.
    await this.refreshing?.catch(() => {});
    this.generation++;
    this.pending = null;
    let revoked = true;
    if (this.profile?.refresh_token) {
      try {
        const metadata = await this.metadata();
        const response = await this.fetcher(metadata.revocation_endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: this.profile.refresh_token, token_type_hint: 'refresh_token', client_id: this.profile.client_id }), signal: AbortSignal.timeout(15000),
        });
        revoked = response.status === 200;
      } catch { revoked = false; }
    }
    this.clearTokens();
    return { revoked };
  }
}
