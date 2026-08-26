# Architecture

This is a Turborepo monorepo for "Open Agents" - an AI coding agent built with AI SDK.

## Core Flow

```
Web -> Agent (packages/agent) -> Sandbox (packages/sandbox)
```

1. **Web** handles authentication, session management, and the primary user interface
2. **Agent** (`deepAgent`) is a `ToolLoopAgent` with tools for file ops, bash, and task delegation
3. **Sandbox** provides the Vercel Sandbox release runtime behind a reusable interface

## Key Packages

- **packages/agent/** - Core agent implementation with tools, subagents, and context management
- **packages/sandbox/** - Execution environment abstraction for cloud sandboxes
- **packages/shared/** - Shared utilities across packages

## MVP runtime boundary

- `apps/web` is the only deployable product surface.
- Vercel Workflow keeps runs durable when the browser disconnects.
- Compute and orchestration are independent choices. Vercel Sandbox is the default
  compute provider; E2B is selectable only when the deployment explicitly enables it
  (`E2B_SANDBOX_ENABLED=true` plus `E2B_API_KEY`). The session's persisted
  `sandboxState.type` is the source of truth for an existing session's provider.
- The Open Agent in `packages/agent` is the only coding-agent runtime.
- Hosted model providers (for example Fireworks) are deployment-managed and run
  outside the sandbox. Only model selection IDs cross durable workflow boundaries;
  credentials are resolved during server-side execution and are never passed to the
  sandbox.
- Both sandbox providers start with deny-all egress and open network access only
  temporarily for GitHub brokerage or approved dependency registries.
- `apps/api`, `apps/worker`, and `packages/control-plane` are experimental and must not
  be deployed for this milestone.

## Subagent Pattern

The `task` tool delegates to specialized subagents:
- **explorer**: Read-only, for codebase research (grep, glob, read, safe bash)
- **executor**: Full access, for implementation tasks (all tools)

## Workspace Structure

```
apps/
  web/           # Web interface
packages/
  agent/         # Core agent logic (@open-agents/agent)
  sandbox/       # Sandbox abstraction (@open-agents/sandbox)
  shared/        # Shared utilities (@open-agents/shared)
  tsconfig/      # Shared TypeScript configs
```
