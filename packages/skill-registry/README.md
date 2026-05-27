# @agent-os/skill-registry

Status: public-experimental.

Skill is install-time identity, not runtime identity. This package validates a
skill manifest and registers its tools through `defineRegisteredTool`. After
registration, submit/admitters/ledger readers only see core `Tool` entries.

The package does not export ledger events, projections, install audit facts,
zip install policy, discovery, or MCP transport.
