import { createServer, type IncomingMessage, type Server } from 'node:http';
import { verifySignature } from './signature.js';

const MAX_BODY_BYTES = 64 * 1024;
const SEEN_LIMIT = 2000;

export interface ServerDeps {
  webhookSecret: string;
  /** Called once per verified, de-duplicated `message.received`. */
  onMessageReceived: (conversationId: string) => void;
  health: () => Record<string, unknown>;
  log: (line: string, extra?: Record<string, unknown>) => void;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * HTTP surface:
 *   GET  /health          → liveness for Hostinger
 *   POST /webhooks/wacrm  → CRM event deliveries (HMAC-verified)
 */
export function createAgentServer(deps: ServerDeps): Server {
  // Delivery ids already handled, so a re-sent event can't trigger a
  // second turn. Bounded: oldest ids drop off first.
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
  };

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0];

    try {
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return send(200, { ok: true, ...deps.health() });
      }

      if (req.method === 'POST' && path === '/webhooks/wacrm') {
        const raw = await readBody(req);
        if (raw === null) return send(413, { error: 'body too large' });

        const signature = req.headers['x-wacrm-signature'];
        if (!verifySignature(typeof signature === 'string' ? signature : undefined, raw, deps.webhookSecret)) {
          deps.log('rejected webhook: bad signature');
          return send(401, { error: 'invalid signature' });
        }

        let event: { id?: string; event?: string; data?: { conversation_id?: string } };
        try {
          event = JSON.parse(raw);
        } catch {
          return send(400, { error: 'invalid JSON' });
        }

        if (event.id) {
          if (seen.has(event.id)) return send(200, { ok: true, duplicate: true });
          remember(event.id);
        }
        if (event.event === 'message.received' && event.data?.conversation_id) {
          deps.onMessageReceived(event.data.conversation_id);
        }
        // Acknowledge fast; the turn runs after the debounce.
        return send(200, { ok: true });
      }

      send(404, { error: 'not found' });
    } catch (err) {
      deps.log('request failed', { error: String(err) });
      if (!res.headersSent) send(500, { error: 'internal error' });
    }
  });
}
