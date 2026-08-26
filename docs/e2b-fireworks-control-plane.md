# E2B + Fireworks Control Plane

> **Experimental only.** This standalone API/worker path is not authenticated by
> the web product, is not part of the supported deployment, and must not be
> exposed publicly. The supported product uses `apps/web`, the existing Open
> Agent, and Vercel Workflow; it may use Vercel Sandbox or explicitly enabled
> E2B compute. Running Codex inside E2B through this separate control plane
> remains experimental.

This fork keeps the Open Agents web product shell and adds a separate control
plane for E2B-hosted Codex runs.

## Services

- `apps/api`: HTTP API and SSE replay endpoint.
- `apps/worker`: BullMQ worker that creates/resumes E2B sandboxes and runs
  `codex exec --json`.
- `packages/control-plane`: shared Postgres, queue, event, GitHub PR, and Codex
  runner logic.
- `packages/sandbox/e2b`: E2B implementation of the existing sandbox contract.

## Required Environment

```env
POSTGRES_URL=postgres://...
REDIS_URL=redis://...
E2B_API_KEY=...
FIREWORKS_API_KEY=...
E2B_CODEX_TEMPLATE=open-agents-codex-fireworks
```

## Build The E2B Template

```bash
cd templates/e2b-codex
pnpm dlx tsx build.ts
```

If you do not build a custom template, set `E2B_CODEX_TEMPLATE=codex` and the
adapter will write the Fireworks Codex config when each sandbox starts.

## Run Locally

```bash
docker compose -f compose.control-plane.yaml up --build
```

Or run services directly:

```bash
pnpm api
pnpm worker
```

## API

Create a run:

```bash
curl -X POST http://localhost:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "userId": "local-user",
    "repo": "https://github.com/OWNER/REPO.git",
    "branch": "main",
    "prompt": "Fix the failing tests",
    "githubToken": "ghs_short_lived_installation_token"
  }'
```

Stream events:

```bash
curl -N http://localhost:8787/runs/RUN_ID/events
```

Read diff:

```bash
curl http://localhost:8787/sessions/SESSION_ID/diff
```

Open a PR:

```bash
curl -X POST http://localhost:8787/sessions/SESSION_ID/pr \
  -H 'content-type: application/json' \
  -d '{"githubToken":"ghs_short_lived_installation_token"}'
```

## Security Notes

The control plane should use GitHub App installation tokens with short TTLs.
Tokens are passed only for clone/push operations and are not stored in sandbox
git remotes. The sandbox agent works on a local checkout and should not call
GitHub write APIs directly.
