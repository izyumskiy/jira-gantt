# Change: add-llm-connection (US-7. Подключение ChatGPT / DeepSeek)

## Why
Поправки и объяснение (US-8, US-9) делает LLM. Компания использует ChatGPT и DeepSeek по ключу API.

**История.** Как менеджер, я хочу указать в настройках провайдера, ключ и модель, чтобы AI-анализ мог
обращаться к LLM.

## What Changes
- «Настройки → AI»: провайдер (ChatGPT / DeepSeek), ключ у каждого свой, модель (по умолчанию
  `gpt-5-nano` / `deepseek-v4-flash`), «Проверить».
- Клиент `src/llm/client.js` на `fetch` в формате Chat Completions, ответ в режиме JSON, один повтор
  при 429/5xx.
- Ключи — в `chrome.storage.local`, не в экспорте конфигурации.

Основание — ТЗ, блок А7.

## Impact
- **Код:** новый `src/llm/client.js`; настройки, `configio.js` (исключение ключей), словарь.
- **Сеть:** разрешение на `api.openai.com` / `api.deepseek.com` запрашивается при сохранении ключа.
