export function parseIdList(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter((item) => /^-?\d+$/.test(item)));
}

export function isGuideKey(value) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(String(value || ""));
}

export function isHttpsUrl(value) {
  try { return new URL(String(value)).protocol === "https:"; }
  catch { return false; }
}

export function fullName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "Пользователь";
}

export function topicTitle(prefix, from) {
  const fixed = `${prefix || "ЛИД"} · `;
  const suffix = ` #${from.id}`;
  const maxNameLength = Math.max(1, 128 - fixed.length - suffix.length);
  return `${fixed}${fullName(from).slice(0, maxNameLength)}${suffix}`;
}

export function keyboard(rows) { return { inline_keyboard: rows }; }

export function parseJson(value, fallback = null) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

export function parseScheduleInput(input, defaultOffset = "+03:00") {
  const match = String(input || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", explicitOffset] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${explicitOffset || defaultOffset}`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace(".000Z", "").replace(/Z$/, "");
}

export function compactError(error, maxLength = 500) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "Telegram API").slice(0, maxLength);
}

export function retryAt(attempt, baseSeconds = 30, maxSeconds = 3600) {
  const seconds = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + seconds * 1000).toISOString().replace("T", " ").replace(".000Z", "").replace(/Z$/, "");
}

export function validateGuide(input) {
  if (!input || typeof input !== "object") return "Нужен JSON-объект.";
  if (!isGuideKey(input.guide_key)) return "guide_key: 1–32 символа A–Z, a–z, 0–9, _ или -.";
  if (!String(input.title || "").trim()) return "Не заполнено название title.";
  if (!input.document_file_id && !isHttpsUrl(input.document_url)) return "Укажите document_file_id или HTTPS-ссылку document_url.";
  for (const field of ["document_url", "consultation_url", "followup_url"]) {
    if (input[field] && !isHttpsUrl(input[field])) return `${field} должен быть HTTPS-ссылкой.`;
  }
  return null;
}

