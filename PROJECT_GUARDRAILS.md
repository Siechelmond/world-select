# World Select — Project Guardrails

Status: binding for all implementation work in this repository.

## Repository isolation

- World Select work is restricted to `Siechelmond/world-select`.
- Do not commit, push, open PRs, change settings, create branches, or alter files in any other repository.
- In particular, do not touch Stock Select, Pool Select, their repositories, branches, deployments, or databases.
- If an operation resolves to another repository, project, database, environment, or deployment: **STOP before mutation**.

## Deployment isolation

- World Select may use its own Vercel project later.
- Never reconfigure an existing SELECT deployment for World Select.
- Production promotion requires explicit owner approval.

## Data isolation

- MVP v1 has no database dependency.
- If persistence is introduced later, use a dedicated World Select database/project or an explicitly isolated database/schema approved by the owner.
- Never reuse or modify Stock Select / Pool Select tables or migrations.

## Secrets

- Never commit API keys, access tokens, connection strings, or credentials.
- Browser-visible keys must be explicitly classified as public and domain-restricted.
- Server-side secrets belong only in the World Select environment.

## Product / safety boundary

- No face recognition.
- No named-person search or individual-person tracking.
- Every external data layer must expose provenance and freshness/status where possible.
- Distinguish observed/live data from calculated, estimated, simulated, stale, and unavailable states.

## Engineering rule

Prefer one normalized spatial entity model over one-off feature implementations.
