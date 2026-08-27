function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class TelegramError extends Error {
  constructor(method, description, { errorCode = 0, httpStatus = 0, retryAfter = 0 } = {}) {
    super(`${method}: ${description || "Telegram API error"}`);
    this.name = "TelegramError";
    this.method = method;
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
  }
}

export function isBlockedError(error) {
  return /blocked by the user|user is deactivated|chat not found|bot was blocked|kicked/i.test(String(error));
}

function shouldRetry(error) {
  if (!(error instanceof TelegramError)) return true;
  return error.httpStatus >= 500 || error.errorCode === 429 || error.errorCode >= 500;
}

export async function telegram(env, method, payload = {}, maxAttempts = 4) {
  if (!env.BOT_TOKEN) throw new TelegramError(method, "BOT_TOKEN не настроен");
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let response;
      try {
        response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new TelegramError(method, "временная сетевая ошибка");
      }
      let data;
      try { data = await response.json(); }
      catch { throw new TelegramError(method, "Telegram вернул некорректный ответ", { httpStatus: response.status }); }
      if (!data.ok) {
        throw new TelegramError(method, data.description, {
          errorCode: Number(data.error_code || 0),
          httpStatus: response.status,
          retryAfter: Number(data.parameters?.retry_after || 0),
        });
      }
      return data.result;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      const retryAfterMs = error instanceof TelegramError ? error.retryAfter * 1000 : 0;
      const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
      await sleep(Math.max(retryAfterMs, backoffMs));
    }
  }
  throw lastError;
}

