/**
 * Given-name equivalence groups (nickname, short form, common cross-language form).
 * Generic public knowledge, no people. Two first names are nickname-equivalent
 * when they share at least one group. A short form that serves two long forms
 * (for example "alex") sits in both groups, and the long forms stay distinct.
 *
 * The table is deliberately small. Anything not listed is not a nickname match;
 * a roster-specific alias belongs in the staff entry's `aliases`, not here.
 */
const GROUPS: readonly (readonly string[])[] = [
  ['alexander', 'alex', 'sasha', 'sandy', 'xander', 'aleksandr', 'alexandr', 'oleksandr'],
  ['alexandra', 'alex', 'sasha', 'sandra', 'lexi', 'aleksandra'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty', 'eliza', 'elisabeth', 'elzbieta'],
  ['katherine', 'catherine', 'kate', 'katie', 'kathy', 'cathy', 'katya', 'katarzyna', 'kasia'],
  ['ekaterina', 'yekaterina', 'katya', 'kate'],
  ['michael', 'mike', 'mick', 'mikey', 'misha', 'mikhail'],
  ['william', 'will', 'bill', 'billy', 'willy'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie'],
  ['richard', 'rick', 'rich', 'dick', 'richie'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'johnny', 'jack', 'jon', 'johan', 'johann'],
  ['jonathan', 'jon', 'jonny', 'nathan'],
  ['thomas', 'tom', 'tommy', 'tomasz'],
  ['christopher', 'chris', 'kit', 'krzysztof', 'christoph'],
  ['christina', 'christine', 'chris', 'tina', 'kristina', 'krystyna'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davey'],
  ['matthew', 'matt', 'matthias', 'mateusz'],
  ['nicholas', 'nick', 'nico', 'nikolai', 'nikolay', 'mikolaj'],
  ['margaret', 'maggie', 'meg', 'peggy', 'margo', 'margarita', 'gosia', 'malgorzata'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['patrick', 'pat', 'paddy'],
  ['jennifer', 'jen', 'jenny', 'jenn'],
  ['stephen', 'steven', 'steve', 'stefan', 'stephan'],
  ['anthony', 'antony', 'tony', 'antoni'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy', 'edvard'],
  ['benjamin', 'ben', 'benny', 'benji'],
  ['samuel', 'sam', 'sammy'],
  ['joseph', 'joe', 'joey', 'josef', 'jozef'],
  ['andrew', 'andy', 'drew', 'andrei', 'andrey', 'andrzej', 'andreas'],
  ['peter', 'pete', 'petr', 'pyotr', 'piotr', 'pieter'],
  ['dmitry', 'dmitri', 'dima', 'dimitri', 'dmytro'],
  ['vladimir', 'vlad', 'volodya', 'wladimir', 'volodymyr'],
  ['sergey', 'sergei', 'serge', 'serhii', 'sergej', 'seryozha'],
  ['anna', 'ann', 'anya', 'hanna', 'hannah', 'ania'],
  ['maria', 'marie', 'masha', 'mary', 'marija', 'mariya'],
  ['sophia', 'sofia', 'zofia', 'sophie', 'sonia', 'sonya'],
  ['oleksiy', 'alexei', 'aleksei', 'alexey', 'aleksey', 'alyosha'],
  ['yuri', 'yuriy', 'iurii', 'jurij', 'yura'],
  ['nathaniel', 'nate', 'nat'],
  ['olivia', 'liv', 'livvy'],
  ['isabella', 'isabel', 'bella', 'izabela'],
];

const index = new Map<string, Set<number>>();
GROUPS.forEach((group, i) => {
  for (const name of group) {
    const set = index.get(name) ?? new Set<number>();
    set.add(i);
    index.set(name, set);
  }
});

/** True when the two primary first-name tokens are the same name or share a group. */
export function nicknameEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = index.get(a);
  const gb = index.get(b);
  if (!ga || !gb) return false;
  for (const g of ga) if (gb.has(g)) return true;
  return false;
}
