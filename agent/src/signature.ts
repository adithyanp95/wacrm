import { createHmac, timingSafeEqual } from 'node:crypto';

/** Reject deliveries signed more than this long ago (replay protection). */
const TOLERANCE_SECONDS = 300;

/**
 * Verify the CRM's `X-Wacrm-Signature: t=<unix>,v1=<hex>` header, where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Must be computed over
 * the exact raw body bytes, before any JSON parsing.
 */
export function verifySignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const fields = new Map(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()] as const;
    }),
  );
  const t = fields.get('t');
  const v1 = fields.get('v1');
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) return false;
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
