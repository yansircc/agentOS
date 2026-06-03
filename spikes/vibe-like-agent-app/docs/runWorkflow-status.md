# runWorkflow Status

module: runWorkflow

status: experimental

ship date: 2026-06-03

review date: 2027-06-03

promotion criteria:

- used by one production app for at least 3 months without major API churn
- second app evaluating adoption confirms the shape fits
- no more than 2 breaking a58 projection signature changes in the first 30 days
- no stable package imports from `spikes/vibe-like-agent-app/*`

kill/quarantine condition:

- quarantine to spike-only if promotion criteria are not met by review date
- retire if product direction changes or the module is bypassed by app-local run state
- redesign a58 if 3 or more stream/projection bypasses appear in the product

API churn count: 0

production usage evidence: none yet; current evidence is the local fake loop only
