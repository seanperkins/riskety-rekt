# GitHub Actions production deployment

**Status:** approved in chat 2026-08-19; awaiting review before implementation.

Deploy the existing production upgrade path automatically after a qualifying push
to `main` passes the same local gates currently used before a manual deploy:

```text
push main (deploy-relevant files)
  -> npm ci
  -> npm run typecheck
  -> npm test
  -> SSH to droplet
  -> bash -s < deploy/bootstrap.sh
  -> bootstrap health checks services
```

## Why

The deploy mechanism already exists and is idempotent. `deploy/bootstrap.sh`
pulls `origin/main`, installs production dependencies, reloads systemd and Caddy,
restarts the long-running services, verifies them, and never touches the database
or `/etc/riskety-rekt/env`. The missing piece is a reproducible, gated caller for
that script.

The workflow replaces only the manual SSH invocation. It does **not** reimplement
bootstrap logic in YAML, run database maintenance, or change the server's own
source-of-truth upgrade path.

## Trigger

One workflow, `.github/workflows/deploy.yml`:

```yaml
on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/deploy.yml"
      - "src/**"
      - "scripts/**"
      - "deploy/**"
      - "package.json"
      - "package-lock.json"
      - "tsconfig.json"
      - "vitest.config.ts"
```

Documentation-only and codemap-only commits do not open an SSH connection. A
workflow edit deploys after it passes its own gates, so the actual production
behavior is tested before the change takes effect.

A single concurrency group, `production-deploy`, has `cancel-in-progress: false`.
A deploy must never be killed halfway through streaming bootstrap to the server.
GitHub may retain only the newest pending run; that is safe because bootstrap
resets the droplet to the current `origin/main`, not a workflow-supplied SHA.

## Gates and action permissions

The job runs on `ubuntu-latest` with:

```yaml
permissions:
  contents: read
```

It uses pinned first-party actions for checkout and Node setup, then runs:

```bash
npm ci
npm run typecheck
npm test
```

No deploy occurs if either gate fails. There is no separate build gate: this
project runs TypeScript through `tsx` and has no bundle or compile artifact.

## SSH identity and host verification

Create one new ED25519 keypair solely for this workflow. It is independent of
personal laptop keys and has this exact deployment-only lifecycle:

| Place | Value | Purpose |
|---|---|---|
| Droplet `/root/.ssh/authorized_keys` | public key, comment `github-actions-riskety-deploy-2026-08-19` | permits the existing root-only bootstrap |
| GitHub Actions secret `DEPLOY_SSH_KEY` | private key | SSH authentication; never printed or written to the repository |
| GitHub Actions secret `DEPLOY_KNOWN_HOSTS` | the droplet's pinned `known_hosts` line for `45.55.240.159` | authenticates the server before sending bootstrap |
| GitHub Actions variable `DEPLOY_HOST` | `45.55.240.159` | non-secret connection target |

The workflow writes the key with mode `0600` and the host record with mode
`0644`, then invokes SSH with:

```bash
ssh -i ~/.ssh/deploy_key \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  root@"$DEPLOY_HOST" 'bash -s' < deploy/bootstrap.sh
```

It never calls `ssh-keyscan` at deploy time: learning a host key from the
network in the same connection that trusts it defeats host verification.

Root is intentional and constrained to this one key because bootstrap installs
systemd units, configures Caddy and creates the backup unit. Rewriting it into
separate remote sudo commands would duplicate its transaction-like deployment
sequence and make partial upgrades easier, not harder.

## Deploy behavior and failure model

- Bootstrap pulls **the server's `origin/main`**. The job does not force-push,
  pass a commit SHA, alter `/etc/riskety-rekt/env`, touch SQLite, or run
  `map:resync`.
- Bootstrap has `set -euo pipefail`; a failed dependency install, Caddy
  validation, service start, or health check makes SSH fail and the workflow red.
- A failed job leaves the previous running service process in place where
  bootstrap's own reload/restart semantics do; recovery is the existing manual
  SSH path, not an automatic retry loop.
- The workflow emits bootstrap's output as the deploy log, including the actual
  server-side short commit at `==> deployed <sha>`.

## Tests

Workflow YAML has no runtime unit-test harness in this repo. Its behavioral gate
is the existing `typecheck` then full offline `test` sequence. Before enabling
production credentials, validate the workflow file structurally with `actionlint`
when available; GitHub's workflow parser is the final syntax gate.

The first qualifying push is the end-to-end proof:

1. Actions shows typecheck and all tests green.
2. Deploy log ends with bootstrap's `==> deployed <server SHA>` and `==> done`.
3. `riskety-web` and `riskety-slack` are active on the droplet.
4. The deployed SHA equals `origin/main` at the time bootstrap pulled.

## Non-goals

- No PR preview deployments, staging environment, manual GitHub Environment
  approval, rollback UI, or database migration workflow.
- No GitHub Action for `map:resync`; it remains a deliberate operator command
  because it rewrites frozen live-season state.
- No deployment on documentation-only pushes.
