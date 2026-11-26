// Test-number chat reset.
//
// Lets the owner wipe a chat with one of their OWN test numbers so the AI
// agent can be tested from a clean start. Only numbers listed in
// NEXT_PUBLIC_TEST_PHONE_NUMBERS (comma-separated, with country code, e.g.
// "918281566545,919876543210") get the option — real customer chats never
// show it, and the server route refuses them too.

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

/** The configured test numbers. Read at build time on the client. */
export function configuredTestNumbers(): Set<string> {
  return parseTestNumbers(process.env.NEXT_PUBLIC_TEST_PHONE_NUMBERS);
}
