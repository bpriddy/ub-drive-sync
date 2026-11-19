/**
 * Synthetic roster for the identity tests. Every name, email and id is invented.
 * The shapes mirror real cases: diacritics, nicknames, transliteration, shared
 * first names, duplicate full names, a hyphenated surname, a former employee,
 * a service account.
 */
import type { RosterEntry } from '../types';

const e = (
  n: number,
  fullName: string,
  startedAt: string,
  extra: Partial<RosterEntry> = {},
): RosterEntry => ({
  staffId: `staff-${String(n).padStart(2, '0')}`,
  fullName,
  email: `user${String(n).padStart(2, '0')}@agency.example`,
  startedAt,
  isActive: true,
  isPerson: true,
  ...extra,
});

export const ROSTER: RosterEntry[] = [
  e(1, 'Zofia Marek-Lindqvist', '2019-03-01', { email: 'zofia.marek-lindqvist@agency.example' }),
  e(2, 'Alexander Voronin', '2018-01-08'),
  e(3, 'Alexandra Voronin', '2020-06-01'),
  e(4, 'José Álvarez-Quintero', '2017-02-01'),
  e(5, 'Jürgen Falkenrath', '2016-09-01'),
  e(6, 'Łukasz Wieczorkiewicz', '2018-05-14'),
  e(7, 'Yuri Kovalenko', '2021-01-11'),
  e(8, 'Taylor Brennan', '2015-04-01'),
  e(9, 'Taylor Brennan', '2024-01-10'),
  e(10, 'Jordan Wexford', '2019-08-01', { isActive: false, endedAt: '2022-12-31' }),
  e(11, 'Jamie Wexford', '2019-09-01'),
  e(12, 'Brand Team Mailbox', '2020-01-01', { isPerson: false }),
  e(13, 'Marta Eklund', '2022-03-01', { aliases: ['Marta Svensson'] }),
  e(14, 'Anna Maria Kowalczyk', '2020-02-03'),
  e(15, 'Samuel Ashworth', '2015-01-05'),
  e(16, 'Sam Ashworth', '2024-02-01'),
  e(17, "Niamh O'Dwyer", '2021-05-03'),
];
