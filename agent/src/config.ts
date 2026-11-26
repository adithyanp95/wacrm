export interface AgentConfig {
  port: number;
  crmUrl: string;
  crmApiKey: string;
  webhookSecret: string;
  openaiApiKey: string;
  /** Overrides the model set in CRM → Settings → AI. */
  openaiModel: string | null;
  debounceMs: number;
  maxWaitMs: number;
  /** Per OpenAI request. */
  llmTimeoutMs: number;
  /** A lead counts as "Silent" after this long without replying to us. */
  silentAfterHours: number;
  /** How often to run the silent check. */
  silentCheckMinutes: number;
}

const REQUIRED = ['WACRM_URL', 'WACRM_API_KEY', 'WACRM_WEBHOOK_SECRET', 'OPENAI_API_KEY'] as const;

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read and validate configuration; throws naming every missing variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const crmUrl = env.WACRM_URL!.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(crmUrl)) {
    throw new Error('WACRM_URL must start with https:// (or http:// for local testing)');
  }
  return {
    port: int(env.PORT, 3001),
    crmUrl,
    crmApiKey: env.WACRM_API_KEY!.trim(),
    webhookSecret: env.WACRM_WEBHOOK_SECRET!.trim(),
    openaiApiKey: env.OPENAI_API_KEY!.trim(),
    openaiModel: env.OPENAI_MODEL?.trim() || null,
    debounceMs: int(env.DEBOUNCE_MS, 10_000),
    maxWaitMs: int(env.MAX_WAIT_MS, 30_000),
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 45_000),
    silentAfterHours: int(env.SILENT_AFTER_HOURS, 72),
    silentCheckMinutes: int(env.SILENT_CHECK_MINUTES, 60),
  };
}
