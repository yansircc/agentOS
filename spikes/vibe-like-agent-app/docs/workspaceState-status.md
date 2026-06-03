# workspaceState Status

module: workspaceState

status: experimental

ship date: 2026-06-03

review date: 2027-06-03

promotion criteria:

- file, git, port, artifact, and url projections are used by one production app
  for at least 3 months without major API churn
- second app evaluating adoption confirms the collection projection shape fits
- no stable package imports from `spikes/vibe-like-agent-app/*`

kill/quarantine condition:

- quarantine to spike-only if promotion criteria are not met by review date
- retire if product workspace state bypasses a58 projections in 3 or more places
- keep Cloudflare Sandbox/provider details out of projection state

API churn count: 0

production usage evidence: none yet; current evidence is the local workspace
projection loop only
