/**
 * The inbox: one shape for everything that is waiting on a person, and one place that gathers it.
 *
 * `items.ts` turns an entity into a row a person can read (the words, the facts, the buttons);
 * `collect.ts` finds the entities. Both were written for the phone and both now serve the panel
 * too — see the note at the top of `collect.ts` for what is deliberately left to each caller
 * (scope, and the mobile-only «скрыл напоминание»).
 */
export * from './items';
export * from './collect';
