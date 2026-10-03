/**
 * The APM transactions running now, so an error reported during one carries
 * its id as `context.transaction_id` and errorgap links the two.
 *
 * Hermes has no AsyncLocalStorage, so there is no way to know which of two
 * overlapping async transactions an error belongs to. When exactly one is
 * running — the usual case for a screen or interaction — its id is used; when
 * several overlap, none is, rather than possibly the wrong one. The callback
 * of `trackTransaction` gets the id (`spans.transactionId`) for exact linking:
 * `Errorgap.notify(error, { context: { transaction_id: spans.transactionId } })`.
 */
const active = new Set<string>();

export function beginTransaction(id: string): void {
  active.add(id);
}

export function endTransaction(id: string): void {
  active.delete(id);
}

/** The running transaction's id when exactly one is running. */
export function currentTransactionId(): string | undefined {
  if (active.size !== 1) return undefined;
  return active.values().next().value;
}

/** A random (version 4) UUID. */
export function newTransactionId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  // Hermes before RN 0.74 has no crypto.randomUUID.
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
