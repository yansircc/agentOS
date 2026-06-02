# a54: Schema Carrier Reference Generator

## Situation

Carrier vocabulary, payload fields, settlement vocabulary, material
requirements, authority requirements, and rejection kinds already live in
structured code. Handwritten carrier reference tables would duplicate those
facts and drift from `defineCarrier`, boundary contracts, and schema
declarations.

## Options

- Keep carrier reference as package prose.
- Generate carrier and schema reference from structured carrier declarations.
- Add localized schema metadata before the generator exists.

## Decision

a54 should generate carrier and schema reference from structured carrier,
boundary contract, settlement contract, and schema declarations. Package docs
keep explaining why and when to use a carrier; generated reference pages own
event kinds, payload fields, claim phase, settlement vocabulary, projection
contracts, material requirements, authority requirements, rejection kinds, and
symbolic proof refs.

Descriptions stay English in v1. Bilingual schema metadata is not added unless
at least two carriers need translated schema descriptions.

## Kill Criterion

If two claim-bearing packages grow handwritten carrier vocabulary tables, start
a54 before adding another table. If generated pages cannot prove agreement with
carrier exports and schema fields, keep the generator private until that proof
exists.

## Revisit

Revisit when two carriers need the same generated reference shape, or when
Effect Schema annotations are rich enough to carry useful reference text without
duplicating carrier facts in markdown.
