# productToolsDeploy Status

module: productToolsDeploy

status: experimental

ship date: 2026-06-03

review date: 2027-06-03

promotion criteria:

- product tool set is used by one production app for at least 3 months without
  major API churn
- second app evaluating adoption confirms at least one tool group fits without
  product-specific semantics
- deploy facts remain symbolic refs and digests only
- no stable package imports from `spikes/vibe-like-agent-app/*`

kill/quarantine condition:

- quarantine to spike-only if promotion criteria are not met by review date
- retire any tool that has no production usage by review date
- do not add Cloudflare product adapters unless the product flow actually uses
  them

API churn count: 0

production usage evidence: none yet; current evidence is local tool/deploy
contract tests only

surface metric:

`rg "defineTool" spikes/vibe-like-agent-app/src` currently counts 9 product
tools.
