import type en from './locales/en';

/**
 * The English dictionary is the schema. Widening its literal types to `string`
 * gives every other locale a structural contract to satisfy: same keys, same
 * nesting, free text. A translator can add a locale file and the compiler tells
 * them exactly what is missing.
 */
type Loosen<T> = T extends string
  ? string
  : { -readonly [K in keyof T]: Loosen<T[K]> };

export type Dictionary = Loosen<typeof en>;

/**
 * Every valid dot-path through the dictionary, e.g. `transactions.status.POSTED`.
 * `t()` accepts this type, so a typo is a build failure rather than a raw key
 * rendered to a user.
 */
type Paths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
    }[keyof T & string];

export type TranslationKey = Paths<Dictionary>;

export type TranslationParams = Record<string, string | number>;
