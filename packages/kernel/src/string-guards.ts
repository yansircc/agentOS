import { Predicate, String as EffectString } from "effect";

export const isNonEmptyString = (value: unknown): value is string =>
  Predicate.isString(value) && EffectString.isNonEmpty(value);
