import { StoreCredential } from './credentials.js';

export class HubError extends Error {
  constructor(
    readonly status: number,
    code: string
  ) {
    super(code);
  }
}

const HUB_TIMEOUT_MS = 10 * 1000;

export interface HubConfig {
  hubApiUrl: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export class HubClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly config: HubConfig) {}

  /** Trade the code from an install redirect for that store's credential. */
  async exchangeCode(code: string): Promise<{ store: string; credential: StoreCredential }> {
    const body = await this.requestToken({
      grant_type: 'authorization_code',
      code,
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
      redirect_uri: this.config.redirectUri,
    });

    if (!body.store) {
      throw new HubError(200, 'store_missing');
    }

    return {
      store: body.store,
      credential: { clientId: body.app_id, clientSecret: body.app_secret, scope: body.scope ?? '' },
    };
  }

  async accessToken(store: string, credential: StoreCredential): Promise<string> {
    const cached = this.tokens.get(store);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const body = await this.requestToken({
      grant_type: 'client_credentials',
      app_id: credential.clientId,
      app_secret: credential.clientSecret,
    });

    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new HubError(200, 'access_token_missing');
    }

    // Renew a minute early so a token never expires mid-request.
    this.tokens.set(store, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 });

    return body.access_token;
  }

  forget(store: string): void {
    this.tokens.delete(store);
  }

  private async requestToken(payload: Record<string, string>): Promise<Record<string, any>> {
    const response = await fetch(`${this.config.hubApiUrl.replace(/\/+$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, any>;

    if (!response.ok) {
      throw new HubError(response.status, body.error ?? 'token_request_failed');
    }

    return body;
  }
}
