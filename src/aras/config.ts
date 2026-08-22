/** Configurazione letta dall'ambiente, con default per l'istanza locale di sviluppo. */
export interface ArasConfig {
  baseUrl: string;
  database: string;
  username: string;
  password: string;
  clientId: string;
  /** Blocca create/update/delete. Default true: le scritture vanno abilitate esplicitamente. */
  readOnly: boolean;
  /** Timeout per singola richiesta HTTP, ms. */
  timeoutMs: number;
  /** Radice dell'installazione Aras sul disco, per leggere i log del server. */
  installDir: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variabile d'ambiente mancante: ${name}`);
}

export function loadConfig(): ArasConfig {
  const baseUrl = env("ARAS_URL", "http://localhost/InnovatorServer").replace(/\/+$/, "");
  return {
    baseUrl,
    database: env("ARAS_DATABASE", "InnovatorSolutions"),
    username: env("ARAS_USER", "admin"),
    password: env("ARAS_PASSWORD", "innovator"),
    clientId: env("ARAS_CLIENT_ID", "IOMApp"),
    // Le scritture su un PLM sono versionate e tracciate: si abilitano di proposito.
    readOnly: env("ARAS_READONLY", "true").toLowerCase() !== "false",
    timeoutMs: Number(env("ARAS_TIMEOUT_MS", "120000")),
    installDir: env("ARAS_INSTALL_DIR", "C:\\Program Files (x86)\\Aras\\Innovator"),
  };
}

export const ODATA = (c: ArasConfig) => `${c.baseUrl}/Server/OData`;
export const TOKEN_URL = (c: ArasConfig) => `${c.baseUrl}/OAuthServer/connect/token`;
export const AML_URL = (c: ArasConfig) => `${c.baseUrl}/Server/InnovatorServer.aspx`;
