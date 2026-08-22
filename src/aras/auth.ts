import { ArasConfig, TOKEN_URL } from "./config.js";

/**
 * Gestione del token OAuth 2.0 (Resource Owner Password Credentials).
 * Aras emette token da 3600s; li rinnoviamo 60s prima della scadenza in modo che
 * una sessione MCP lunga non fallisca a meta' di una catena di chiamate.
 */
export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly cfg: ArasConfig) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    // Se piu' tool chiedono il token insieme, una sola richiesta parte davvero.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Forza il rinnovo: usato quando una chiamata torna 401 nonostante il token sembrasse valido. */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.cfg.clientId,
      scope: "Innovator",
      database: this.cfg.database,
      username: this.cfg.username,
      password: this.cfg.password,
    });

    const res = await fetch(TOKEN_URL(this.cfg), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Autenticazione Aras fallita (HTTP ${res.status}) su database "${this.cfg.database}" ` +
          `come "${this.cfg.username}". ${detail.slice(0, 400)}`
      );
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    return this.token;
  }
}
