# tenantConfig Status

module: tenantConfig

status: experimental

ship date: 2026-06-03

review date: 2027-06-03

promotion criteria:

- credential and skill metadata projections are used by one production app for
  at least 3 months without major API churn
- second app evaluating adoption confirms tenant config metadata shape fits
- no stable package imports from `spikes/vibe-like-agent-app/*`

kill/quarantine condition:

- quarantine to spike-only if promotion criteria are not met by review date
- retire if credential or skill policy diverges from the projection model
- redesign if raw secrets or zip bodies are required in ledger-visible state

API churn count: 0

production usage evidence: none yet; current evidence is the local tenant
metadata loop only
