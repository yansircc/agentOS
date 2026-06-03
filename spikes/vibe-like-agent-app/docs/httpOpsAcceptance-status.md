# httpOpsAcceptance Status

module: httpOpsAcceptance

status: experimental

ship date: 2026-06-03

review date: 2027-06-03

promotion criteria:

- app-owned HTTP endpoint inventory and OpenAPI shape are used by one production
  app for at least 3 months without major API churn
- Scalar reference route remains app-local or repeated boilerplate is proven
  across apps before any helper is promoted
- ops reads substrate status/rebuild without embedding product policy
- numeric acceptance metrics are collected from production-like runs

kill/quarantine condition:

- quarantine to spike-only if promotion criteria are not met by review date
- retire HTTP helper code if `@effect/platform` usage remains app-specific
- do not promote ops pages that include product-specific workflow policy

API churn count: 0

production usage evidence: none yet; current evidence is local OpenAPI, ops,
and acceptance tests only
