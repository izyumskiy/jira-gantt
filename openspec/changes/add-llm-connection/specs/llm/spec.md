# Spec delta — llm (add-llm-connection)

## ADDED Requirements

### Requirement: Настройки провайдера
Плагин SHALL давать выбрать провайдера (ChatGPT или DeepSeek), задать ключ API для каждого и модель
(по умолчанию `gpt-5-nano` и `deepseek-v4-flash`). Ключи SHALL храниться в `chrome.storage.local` и
SHALL NOT попадать в экспорт конфигурации. При сохранении ключа SHALL запрашиваться разрешение на домен
провайдера.

#### Scenario: Экспорт без ключей
- **WHEN** пользователь экспортирует конфигурацию
- **THEN** ключей API в файле нет

### Requirement: Запрос к LLM
Клиент SHALL отправлять `POST` в формате Chat Completions на `https://api.openai.com/v1/chat/completions`
или `https://api.deepseek.com/chat/completions` с `response_format: {type: "json_object"}` для
JSON-ответов. При 429 и 5xx SHALL выполняться один повтор через 2 секунды.

#### Scenario: Проверка связи
- **WHEN** пользователь нажимает «Проверить»
- **THEN** короткий запрос к провайдеру; ответ «связь есть» или текст ошибки провайдера

#### Scenario: Повтор
- **WHEN** провайдер ответил 429, затем 200
- **THEN** клиент возвращает ответ второго запроса
