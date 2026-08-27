const TRANSIENT_D1 = /Network connection lost|storage caused object to be reset|reset because its code was updated|database is locked|temporar|timeout|internal error/i;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function withD1Retry(operation, maxAttempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !TRANSIENT_D1.test(String(error))) throw error;
      await sleep(Math.min(2000, 80 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100));
    }
  }
  throw lastError;
}

export function dbRun(env, sql, params = [], attempts = 5) {
  return withD1Retry(() => env.DB.prepare(sql).bind(...params).run(), attempts);
}
export function dbFirst(env, sql, params = []) {
  return withD1Retry(() => env.DB.prepare(sql).bind(...params).first(), 3);
}
export function dbAll(env, sql, params = []) {
  return withD1Retry(() => env.DB.prepare(sql).bind(...params).all(), 3);
}
export function dbBatch(env, statements, attempts = 5) {
  return withD1Retry(() => env.DB.batch(statements), attempts);
}

