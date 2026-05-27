export interface ContextRedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

export interface ContextFact {
  readonly ref: string;
  readonly kind: string;
  readonly text: string;
  readonly priority?: number;
  readonly tokenCount?: number;
  readonly redactions?: ReadonlyArray<ContextRedactionSpan>;
}

export interface ContextPackOptions {
  readonly includeKinds?: ReadonlyArray<string>;
  readonly excludeKinds?: ReadonlyArray<string>;
  readonly maxItems?: number;
  readonly maxChars?: number;
  readonly maxTokens?: number;
  readonly separator?: string;
}

export type ContextOmitReason =
  | "kind_not_included"
  | "kind_excluded"
  | "item_budget"
  | "char_budget"
  | "token_budget"
  | "missing_token_count"
  | "invalid_redaction";

export interface ContextOmittedRef {
  readonly ref: string;
  readonly reason: ContextOmitReason;
}

export interface ContextPackItem {
  readonly ref: string;
  readonly kind: string;
  readonly text: string;
  readonly charCount: number;
  readonly tokenCount?: number;
}

export interface ContextPack {
  readonly text: string;
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly includedRefs: ReadonlyArray<string>;
  readonly omittedRefs: ReadonlyArray<ContextOmittedRef>;
  readonly stats: {
    readonly itemCount: number;
    readonly charCount: number;
    readonly tokenCount?: number;
  };
}

interface IndexedFact {
  readonly fact: ContextFact;
  readonly index: number;
}

const DEFAULT_SEPARATOR = "\n\n";

const includesKind = (kinds: ReadonlyArray<string> | undefined, kind: string): boolean =>
  kinds === undefined || kinds.includes(kind);

const excludesKind = (kinds: ReadonlyArray<string> | undefined, kind: string): boolean =>
  kinds !== undefined && kinds.includes(kind);

const priorityOf = (fact: ContextFact): number => fact.priority ?? 0;

const sortedFacts = (facts: Iterable<ContextFact>): ReadonlyArray<IndexedFact> =>
  [...facts]
    .map((fact, index) => ({ fact, index }))
    .sort((a, b) => priorityOf(b.fact) - priorityOf(a.fact) || a.index - b.index);

const validRedactions = (fact: ContextFact): boolean =>
  (fact.redactions ?? []).every(
    (span) =>
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.end >= span.start &&
      span.end <= fact.text.length,
  );

const applyRedactions = (fact: ContextFact): string => {
  const spans = [...(fact.redactions ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let out = "";
  for (const span of spans) {
    if (span.start < cursor) {
      continue;
    }
    out += fact.text.slice(cursor, span.start);
    out += `[redacted:${span.label}]`;
    cursor = span.end;
  }
  out += fact.text.slice(cursor);
  return out;
};

const omitted = (ref: string, reason: ContextOmitReason): ContextOmittedRef => ({ ref, reason });

export const buildContextPack = (
  facts: Iterable<ContextFact>,
  options: ContextPackOptions = {},
): ContextPack => {
  const items: ContextPackItem[] = [];
  const omittedRefs: ContextOmittedRef[] = [];
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  let charCount = 0;
  let tokenCount = 0;
  let hasTokenCount = false;

  for (const { fact } of sortedFacts(facts)) {
    if (!includesKind(options.includeKinds, fact.kind)) {
      omittedRefs.push(omitted(fact.ref, "kind_not_included"));
      continue;
    }
    if (excludesKind(options.excludeKinds, fact.kind)) {
      omittedRefs.push(omitted(fact.ref, "kind_excluded"));
      continue;
    }
    if (options.maxItems !== undefined && items.length >= options.maxItems) {
      omittedRefs.push(omitted(fact.ref, "item_budget"));
      continue;
    }
    if (!validRedactions(fact)) {
      omittedRefs.push(omitted(fact.ref, "invalid_redaction"));
      continue;
    }
    if (options.maxTokens !== undefined && fact.tokenCount === undefined) {
      omittedRefs.push(omitted(fact.ref, "missing_token_count"));
      continue;
    }

    const text = applyRedactions(fact);
    const nextCharCount = charCount + text.length + (items.length === 0 ? 0 : separator.length);
    if (options.maxChars !== undefined && nextCharCount > options.maxChars) {
      omittedRefs.push(omitted(fact.ref, "char_budget"));
      continue;
    }
    const nextTokenCount = tokenCount + (fact.tokenCount ?? 0);
    if (options.maxTokens !== undefined && nextTokenCount > options.maxTokens) {
      omittedRefs.push(omitted(fact.ref, "token_budget"));
      continue;
    }

    items.push({
      ref: fact.ref,
      kind: fact.kind,
      text,
      charCount: text.length,
      ...(fact.tokenCount === undefined ? {} : { tokenCount: fact.tokenCount }),
    });
    charCount = nextCharCount;
    if (fact.tokenCount !== undefined) {
      tokenCount = nextTokenCount;
      hasTokenCount = true;
    }
  }

  return {
    text: items.map((item) => item.text).join(separator),
    items,
    includedRefs: items.map((item) => item.ref),
    omittedRefs,
    stats: {
      itemCount: items.length,
      charCount,
      ...(hasTokenCount ? { tokenCount } : {}),
    },
  };
};
