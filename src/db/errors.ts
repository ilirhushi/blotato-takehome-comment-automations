const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Errors from losing the connection or from contention, which a later attempt can get past. */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true;
  // node-postgres raises these without a code.
  return /Connection terminated|timeout exceeded when trying to connect/.test(err.message);
}
