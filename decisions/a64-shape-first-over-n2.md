# a64: Shape-First Over N>=2

## Situation

N>=2 was used as a proxy for confidence that a capability shape is not
product-specific. It protected agentOS from lifting vibe-specific run workflow,
workspace runtime, and tenant config modules too early. It is too coarse when a
capability is a substrate primitive whose shape is already clear at N=1.

## Options

- Keep strict N>=2 for every substrate addition.
- Remove N>=2 and let maintainers lift capabilities case by case.
- Replace count-first with a shape-clarity gate and keep N>=2 for unclear
  shapes.

## Decision

Replace count-first with a shape-first gate.

Evaluate every proposed substrate lift with five questions:

- Can the API signature be written in less than 50 lines?
- Are the tests domain-independent?
- Do names avoid product vocabulary?
- Can the implementation stay under 500 LOC?
- Does the current substrate structurally require the capability?

Four or five yes answers means absorb now. Two or three yes answers means wait
for N>=2 evidence or a scoped pressure spike. Zero or one yes answer means keep
the capability app-local.

N>=2 remains a useful evidence rule for unclear patterns. It is no longer the
top-level rule for essence-level substrate capabilities.

## Kill Criterion

If three or more shape-first absorptions require breaking redesign within six
months, revert to strict N>=2 until the failed decisions are reviewed.

## Revisit

Revisit in 12 months. Measure how many shape-first absorptions held their shape,
how many were redesigned, and whether the five-question gate needs a different
threshold.
