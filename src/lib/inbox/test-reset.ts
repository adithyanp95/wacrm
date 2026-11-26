// Test-number chat reset.
//
// Lets the owner wipe a chat with one of their OWN test numbers so the AI
// agent can be tested from a clean start. Only numbers listed in
// TEST_PHONE_NUMBERS (or NEXT_PUBLIC_TEST_PHONE_NUMBERS) — comma-separated,
// with country code, e.g. "918281566545,919876543210" — get the option.
// Real customer chats never show it, and the server route refuses them too.
//
// The list is read on the SERVER at runtime and handed to the browser by
// GET /api/conversations/test-numbers. A NEXT_PUBLIC_ value read in client
// code is frozen at build time, so a host that only provides env vars when
// the app runs (Hostinger) would ship an empty list.

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Parse the comma-separated env value into a set of digit-only numbers. */
export function parseTestNumbers(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const d = digits(part);
    if (d) out.add(d);
  }
  return out;
}

/** True when `phone` is one of the configured test numbers. */
export function isTestNumber(
  phone: string | null | undefined,
  numbers: Set<string>,
): boolean {
  if (!phone) return false;
  const d = digits(phone);
  return d !== "" && numbers.has(d);
}

/**
 * The configured test numbers. SERVER ONLY. Reads `process.env` through a
 * local alias so Next.js doesn't inline the build-time value — the list
 * comes from the environment the app is running in.
 */
export function configuredTestNumbers(): Set<string> {
  const env = process.env;
  return parseTestNumbers(
    env.TEST_PHONE_NUMBERS || env.NEXT_PUBLIC_TEST_PHONE_NUMBERS,
  );
}
