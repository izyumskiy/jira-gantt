// Связь Control Chart с общей таблицей людей OhMyGant («Команда»).
//
// Таблица одна на оба инструмента: профиль человека (команда, роль, системы, статус) лежит в сторе
// people общей базы, ключ — нормализованное имя (team.normName). Отсюда:
//   ccPeople()    — исполнители досок Control Chart, чтобы «Команда» показывала и их;
//   teamProfiles() — профили по имени, чтобы Control Chart показывал команду, роль и статус.

import * as ccdb from './lib/db.js';
import { Dict } from './lib/codec.js';
import * as hostDb from '../js/db.js';
import { normName } from '../js/team.js';
import { t as hostT } from '../js/i18n.js';

/**
 * Исполнители задач на досках Control Chart: имя, на каких досках встречается и сколько задач.
 * @returns {Promise<{name:string, displayName:string, boards:string[], issues:number}[]>}
 */
export async function ccPeople() {
  const [boards, userRec] = await Promise.all([ccdb.getBoards(), ccdb.getDictRecord('user')]);
  const users = Dict.fromRecord(userRec, 'user');
  const byName = new Map();
  for (const board of boards) {
    const boardName = board.name || `#${board.id}`;
    for (const issue of await ccdb.getBoardIssues(board.id)) {
      const displayName = users.name_(issue.as ?? -1).trim();
      if (!displayName) continue;
      const name = normName(displayName);
      if (!byName.has(name)) byName.set(name, { name, displayName, boards: [], issues: 0 });
      const person = byName.get(name);
      person.issues += 1;
      if (!person.boards.includes(boardName)) person.boards.push(boardName);
    }
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Профили людей из «Команды» по нормализованному имени.
 * @returns {Promise<Map<string, {team:string, role:string, status:string, systems:string[]}>>}
 */
export async function teamProfiles() {
  const list = await hostDb.all(hostDb.STORES.people);
  return new Map(list.map((p) => [p.name, p]));
}

/** Подписи роли и статуса — из словаря OhMyGant: у таблицы людей один словарь на оба инструмента. */
export function roleLabel(role) {
  return role ? hostT(`role.${role}`) : '';
}

export function statusLabel(status) {
  return status ? hostT(`pstatus.${status}`) : '';
}

export { normName };
