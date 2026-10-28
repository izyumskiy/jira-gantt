// Клиент REST API Jira Server/Data Center 9.x.
//
// Аутентификация:
//   'cookie' — используем сессию, уже открытую в браузере (credentials: include);
//   'pat'    — Personal Access Token (Jira 8.14+): заголовок Authorization: Bearer;
//   'auto'   — как в OhMyGant: сначала сессия браузера, при отказе в доступе — PAT. Удачный PAT
//              запоминается, чтобы следующие запросы не ходили дважды.

import { t } from './i18n.js';

export class JiraError extends Error {
  constructor(message, { status = 0, url = '', kind = 'http', body = '' } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.url = url;
    this.kind = kind; // http | auth | network | parse
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JiraClient {
  /**
   * @param {{baseUrl:string, authMode?:string, token?:string, timeoutMs?:number}} opts
   */
  constructor({ baseUrl, authMode = 'cookie', token = '', timeoutMs = 60000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.authMode = authMode;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  url(path, params) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request(path, params, opts = {}) {
    if (this.authMode === 'pat') return this.send(path, params, opts, true);
    if (this.authMode === 'auto' && this.token) {
      if (this.patWorks) return this.send(path, params, opts, true);
      try {
        return await this.send(path, params, opts, false);
      } catch (err) {
        if (!(err instanceof JiraError) || err.kind !== 'auth') throw err;
        const out = await this.send(path, params, opts, true);
        this.patWorks = true;
        return out;
      }
    }
    return this.send(path, params, opts, false);
  }

  async send(path, params, { retries = 2 } = {}, usePat = false) {
    const url = this.url(path, params);
    const headers = { Accept: 'application/json' };
    if (usePat && this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers,
          credentials: usePat ? 'omit' : 'include',
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new JiraError(
          t('errors.network', { url: this.baseUrl, message: err.message }),
          { url, kind: 'network' },
        );
      }
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new JiraError(
          usePat ? t('errors.authPat') : t('errors.authCookie'),
          { status: res.status, url, kind: 'auth' },
        );
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 2;
          await sleep(Math.min(retryAfter, 30) * 1000);
          continue;
        }
      }
      const text = await res.text();
      if (!res.ok) {
        throw new JiraError(t('errors.http', { status: res.status, path, message: firstError(text) }), {
          status: res.status, url, body: text.slice(0, 500),
        });
      }
      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('json')) {
        // Обычно это HTML страницы логина или прокси.
        throw new JiraError(t('errors.notJson'), {
          status: res.status, url, kind: 'auth', body: text.slice(0, 300),
        });
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new JiraError(t('errors.parse', { message: err.message }), { url, kind: 'parse' });
      }
    }
  }

  // --------------------------------------------------------------- методы

  myself() {
    return this.request('/rest/api/2/myself');
  }

  serverInfo() {
    return this.request('/rest/api/2/serverInfo');
  }

  /** Список досок (постранично, отдаёт всё). */
  async boards({ name = '', type = '' } = {}) {
    const out = [];
    let startAt = 0;
    for (;;) {
      const page = await this.request('/rest/agile/1.0/board', {
        startAt, maxResults: 50, name, type,
      });
      out.push(...(page.values || []));
      if (page.isLast || !page.values?.length) break;
      startAt += page.values.length;
      if (out.length > 2000) break;
    }
    return out;
  }

  boardConfiguration(boardId) {
    return this.request(`/rest/agile/1.0/board/${boardId}/configuration`);
  }

  /** Одна страница задач доски вместе с историей изменений. */
  boardIssues(boardId, { startAt = 0, maxResults = 50, jql = '', fields = '' } = {}) {
    return this.request(`/rest/agile/1.0/board/${boardId}/issue`, {
      startAt,
      maxResults,
      jql,
      fields,
      expand: 'changelog',
      validateQuery: 'false',
    });
  }

  /** Полная история изменений одной задачи (если в выдаче она обрезана). */
  issueChangelog(issueIdOrKey) {
    return this.request(`/rest/api/2/issue/${issueIdOrKey}`, {
      expand: 'changelog',
      fields: 'created',
    });
  }

  statuses() {
    return this.request('/rest/api/2/status');
  }

  fields() {
    return this.request('/rest/api/2/field');
  }

  /** Ищет id поля Story Points среди пользовательских полей. */
  async detectStoryPointsField() {
    const list = await this.fields();
    const candidates = list.filter((f) => f.custom && /story point/i.test(f.name || ''));
    const exact = candidates.find((f) => /^story points?$/i.test(f.name || ''));
    return (exact || candidates[0])?.id || '';
  }
}

function firstError(text) {
  try {
    const data = JSON.parse(text);
    const list = [...(data.errorMessages || []), ...Object.values(data.errors || {})];
    if (list.length) return list.join('; ');
  } catch { /* не JSON — вернём кусок текста */ }
  return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
