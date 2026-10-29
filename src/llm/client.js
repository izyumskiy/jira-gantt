// Подключение LLM (US-7): ChatGPT (OpenAI) или DeepSeek по ключу API. Оба отвечают в формате
// Chat Completions — один клиент на fetch, без SDK. Ключи — в настройках (chrome.storage.local),
// в экспорт конфигурации не попадают (exportConfig перечисляет поля явно).
import * as settings from "../js/settings.js";

export const PROVIDERS = {
  chatgpt: { url: "https://api.openai.com/v1/chat/completions", origin: "https://api.openai.com/*", model: "gpt-5-nano" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", origin: "https://api.deepseek.com/*", model: "deepseek-v4-flash" }
};
const RETRY_MS = 2000;
const TIMEOUT_MS = 120000;

export class LlmError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Активный провайдер, его ключ и модель.
export function config(s = settings.get()) {
  const id = PROVIDERS[s.llmProvider] ? s.llmProvider : "chatgpt";
  const p = PROVIDERS[id];
  return { id, url: p.url, origin: p.origin, key: String((s.llmKeys || {})[id] || "").trim(), model: String((s.llmModels || {})[id] || "").trim() || p.model };
}

export const hasKey = (s = settings.get()) => !!config(s).key;

// Текст ошибки провайдера: { error: { message } } у обоих.
async function errorText(res) {
  try {
    const body = await res.json();
    return (body && body.error && (body.error.message || body.error.code)) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Запрос к модели. json — ответ объектом (response_format: json_object), иначе текстом.
// При 429 и 5xx — один повтор через 2 секунды.
export async function complete({ messages, json = false, s = settings.get(), fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const c = config(s);
  if (!c.key) throw new LlmError("no key");
  const body = JSON.stringify({ model: c.model, messages, ...(json ? { response_format: { type: "json_object" } } : {}) });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(c.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (e) {
      throw new LlmError(e && e.message ? e.message : String(e));
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(RETRY_MS);
      continue;
    }
    if (!res.ok) throw new LlmError(await errorText(res), res.status);
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || "" : "";
    if (!json) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError("bad json");
    }
  }
}

// «Проверить»: короткий запрос; ошибка провайдера — исключением.
export async function check(opts = {}) {
  const res = await complete({ ...opts, json: true, messages: [{ role: "user", content: 'Reply with JSON {"ok": true}.' }] });
  return !!res;
}
