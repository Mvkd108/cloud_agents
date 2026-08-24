# Deployment companion

## 1. Scope note

README.md's "Deploy your own copy on Vercel" section is the canonical deploy guide.
This document covers ordering hazards, launch qualification, and the verification
checklist.

Only `apps/web` is a supported product deployment. `apps/api`, `apps/worker`,
`packages/control-plane`, and the E2B/Codex template are experimental source
artifacts and must not be deployed or exposed publicly.

The supported runtime is Vercel Workflow plus Vercel Sandbox. The browser is a
control surface only: durable work continues after it disconnects, and hosted
open-weight inference never uses a user's computer.

## 2. The ordering hazard

Steps 5-9 encode a chicken-and-egg problem:

1. Deploy with only `POSTGRES_URL` and `BETTER_AUTH_SECRET` set. Sign-in will fail -- this is expected.
2. Get the stable production URL from the Vercel deployment.
3. Create the Vercel OAuth app and GitHub App using that URL as the domain in their callback URLs.
4. Add their credentials (`NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, and all GitHub App vars) to the Vercel project environment and redeploy.

Sign-in will not work until the second deploy.

## 3. Launch configuration

Run the secret-safe preflight against the environment that will be deployed:

```bash
pnpm launch:preflight -- --env-file=apps/web/.env
```

The preflight blocks until these launch groups are complete:

- Postgres plus a Better Auth secret of at least 32 characters.
- A stable HTTPS `BETTER_AUTH_URL` (or canonical Vercel production URL variable).
- Vercel OAuth credentials for sign-in.
- GitHub App OAuth credentials, app ID, private key, slug, and webhook secret.
- `REDIS_URL` or `KV_URL`. Production rate-limited APIs deliberately return `503`
  without this store; it is not optional for launch.
- A complete OpenAI-compatible provider with at least one enabled, tool-capable model.

Generate `GITHUB_WEBHOOK_SECRET` as an independent random value (for example,
`openssl rand -hex 32`) and enter the same value in the GitHub App webhook settings.
Use `https://YOUR_DOMAIN/api/github/webhook` as the webhook URL.

`ELEVENLABS_API_KEY` remains optional and enables voice transcription only.

## 4. Verification checklist

After deployment, run the anonymous, read-only smoke suite:

```bash
pnpm launch:smoke -- --url=https://YOUR_DOMAIN
```

It checks the application shell, auth status API, model catalog, anonymous session
boundary, and unsigned webhook rejection. It does not create sessions or modify data.
Then complete the authenticated acceptance flow:

1. **Sign in** -- navigate to the app. Click "Sign in with Vercel". You are redirected to Vercel auth and back. *Working: the top-right shows your avatar.*
2. **Connect GitHub** -- in settings or the repo picker, click "Connect GitHub". You are redirected to GitHub OAuth. Authorize the GitHub App. *Working: repo picker shows repos.*
3. **Install the app on a repo** -- when prompted, select a repo and install the GitHub App. *Working: the repo appears in the picker dropdown.*
4. **Pick a repo** -- select the installed repo from the dropdown. *Working: repo name is displayed in the chat header.*
5. **Start a session** -- click "New session" or equivalent. *Working: a chat thread opens with a session ID.*
6. **Send a message** -- type a message (e.g. "list the files in the root directory") and send. *Working: the message appears in chat, a sandbox indicator shows provisioning.*
7. **Confirm sandbox starts** -- wait for the agent to respond. *Working: the agent replies with output or an action confirmation. A sandbox was created.*
8. **Disconnect and resume** -- close the tab while a longer task is running, then
   reopen the same chat. *Working: the durable stream reconnects and the task continues
   without replaying completed work.*
9. **Verify the change** -- ask the agent to edit a fixture, run its tests, and inspect
   the diff. *Working: tests pass and the displayed diff matches the sandbox files.*
10. **Create the PR** -- use the reviewed commit/PR flow. *Working: the branch is pushed
    with a short-lived installation token and the PR targets the expected base branch.*

## 5. Sandbox network policy

Fresh and resumed sandboxes use deny-all egress. Normal shell commands never receive
internet access. The agent can request the approval-gated `install_dependencies` tool,
which detects a JavaScript lockfile and temporarily permits only
`registry.npmjs.org` plus exact domains configured in
`SANDBOX_NPM_REGISTRY_DOMAINS`. Deny-all is restored after success, failure, or
cancellation. Start dependency installation before detached dev-server commands.

GitHub clone, fetch, and publish operations use short-lived GitHub App tokens through
the network-policy broker. Tokens are not written to commands, environments, remotes,
workflow data, or database records.

## 6. Hosted open-weight qualification

Configure one OpenAI-compatible hosted endpoint with
`OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, and
`OPENAI_COMPATIBLE_MODELS`. Every descriptor must declare `enabled`,
`contextWindow`, and `capabilities` for tools, vision, and reasoning. Only enabled,
tool-capable models appear in the UI.

Before setting a descriptor to `enabled: true`, run the opt-in live contract with the
deployment credentials and the raw provider model ID:

```bash
OPENAI_COMPATIBLE_CONTRACT_MODEL_ID=provider/model pnpm provider:contract:live
```

The command exercises streaming, multi-step file tools, a repository edit, tests, and
usage extraction. It is intentionally excluded from normal CI so deployment
credentials never enter CI jobs.

After the contract passes, enable only the qualified descriptor, rerun
`pnpm launch:preflight`, deploy, and run the smoke and authenticated acceptance flows.
