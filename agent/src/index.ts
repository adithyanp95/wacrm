import { loadConfig } from './config.js';
import { createCrmClient } from './crm.js';
import { ConversationScheduler } from './scheduler.js';
import { runTurn, openAiThinker } from './turn.js';
import { createAgentServer } from './server.js';

/** Structured one-line logs. Ids and outcomes only — no message text. */
function log(line: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: line, ...extra }));
}

const DEFAULT_MODEL = 'gpt-5.4-mini';

function main(): void {
  const config = loadConfig();
  const crm = createCrmClient(config.crmUrl, config.crmApiKey);
  const startedAt = new Date().toISOString();
  let turns = 0;

  const scheduler = new ConversationScheduler({
    debounceMs: config.debounceMs,
    maxWaitMs: config.maxWaitMs,
    runTurn: async (conversationId) => {
      turns++;
      await runTurn(
        {
          crm,
          think: openAiThinker(config.openaiApiKey, config.llmTimeoutMs, config.openaiModel),
          defaultModel: DEFAULT_MODEL,
          log,
        },
        conversationId,
      );
    },
    onError: (conversationId, err) => log('turn failed', { conversationId, error: String(err) }),
  });

  const server = createAgentServer({
    webhookSecret: config.webhookSecret,
    onMessageReceived: (conversationId) => scheduler.notify(conversationId),
    health: () => ({ startedAt, turns, pending: scheduler.pending }),
    log,
  });

  server.listen(config.port, () => log('agent listening', { port: config.port }));

  const shutdown = () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (err) {
  console.error(`[agent] failed to start: ${(err as Error).message}`);
  process.exit(1);
}
