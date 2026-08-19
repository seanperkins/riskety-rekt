# GitHub Actions production deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A push to `main` that touches deployable files runs typecheck and the full test suite, then deploys by streaming the existing `deploy/bootstrap.sh` to the droplet over SSH.

**Architecture:** One workflow file. GitHub runs the same two gates a human runs locally, then invokes the server's own idempotent upgrade path — it does not reimplement any deploy step in YAML. A dedicated root SSH key, used by nothing else, authenticates the runner; the server's host key is pinned as a secret so no key is learned from the network at deploy time.

**Tech Stack:** GitHub Actions, `actions/checkout@v4`, `actions/setup-node@v4` pinned to Node 24, OpenSSH client, `deploy/bootstrap.sh` (bash), systemd on the droplet.

**Spec:** `docs/superpowers/specs/2026-08-19-github-actions-deploy-design.md`

## Global Constraints

- **Node 24 exactly.** `deploy/bootstrap.sh:23` refuses to run when the server's node major is `< 24`, and this repo has no `.nvmrc` and no `engines` field, so the runner must pin `node-version: "24"` rather than inherit `ubuntu-latest`'s default major.
- **`permissions: contents: read`.** The job needs nothing else; no package, deployment, or issue scopes.
- **Concurrency group `production-deploy`, `cancel-in-progress: false`.** A half-streamed bootstrap must never be killed.
- **Never `ssh-keyscan` at deploy time.** Host identity comes from the `DEPLOY_KNOWN_HOSTS` secret.
- **Server target:** `root@45.55.240.159`, app root `/srv/riskety-rekt`.
- **The workflow never touches** `/etc/riskety-rekt/env`, SQLite, or `map:resync`.

---

### Task 1: The deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `deploy/README.md` (add a "Deploying from GitHub Actions" section)
- Modify: `CLAUDE.md:44` area (note that pushing `main` deploys)
- Test: none — YAML has no unit harness in this repo; the gate is `actionlint` plus the first real run (Task 3)

**Interfaces:**
- Consumes: `deploy/bootstrap.sh` (unchanged), `npm run typecheck`, `npm test`
- Produces: secret names `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and variable `DEPLOY_HOST`, which Task 2 populates

- [x] **Step 1: Write the workflow**

```yaml
name: deploy

# Docs-only pushes must not open an SSH connection, so the trigger is
# path-filtered. The workflow file itself is included: a change to how deploys
# work should be exercised by the deploy that adopts it.
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
  workflow_dispatch:

permissions:
  contents: read

# NOT cancel-in-progress. Bootstrap is streamed over SSH and reloads systemd
# units halfway through; killing it mid-flight is the one failure mode this
# whole file must not create.
concurrency:
  group: production-deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Pinned to 24 because deploy/bootstrap.sh refuses to run on the droplet
      # below node 24, and this repo declares no engines field for the runner to
      # follow. `npm ci` needs devDependencies: vitest is the gate.
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm

      - run: npm ci

      - run: npm run typecheck

      # The suite is offline by construction -- test/no-network.ts is wired in as
      # vitest.config.ts's setupFiles -- so this needs no services and no secrets.
      - run: npm test

      - name: Deploy
        env:
          DEPLOY_HOST: ${{ vars.DEPLOY_HOST }}
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          test -n "$DEPLOY_HOST" || { echo "DEPLOY_HOST is not set" >&2; exit 1; }

          install -d -m 700 ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 644 ~/.ssh/known_hosts

          # IdentitiesOnly stops ssh offering any other identity the agent knows;
          # StrictHostKeyChecking=yes means the pinned record above is the only
          # host this will talk to. bootstrap.sh is idempotent and is the server's
          # own upgrade path -- it pulls origin/main, installs production deps,
          # reloads units, restarts services, and health-checks them.
          ssh -i ~/.ssh/deploy_key \
            -o IdentitiesOnly=yes \
            -o StrictHostKeyChecking=yes \
            -o ConnectTimeout=15 \
            root@"$DEPLOY_HOST" 'bash -s' < deploy/bootstrap.sh
```

- [x] **Step 2: Lint the workflow**

Run: `actionlint .github/workflows/deploy.yml` (skip if `actionlint` is not installed; GitHub's parser is the final gate)
Expected: no output

- [x] **Step 3: Verify the local gates still pass unchanged**

Run: `npm run typecheck && npm test`
Expected: typecheck silent; `Test Files 83 passed`, `Tests 1059 passed`

- [x] **Step 4: Document it for operators**

In `deploy/README.md`, above "## Running the jobs by hand", add:

```markdown
## Deploying from GitHub Actions

A push to `main` that touches `src/`, `scripts/`, `deploy/`, the workflow, or a
package/tsconfig/vitest file runs `npm run typecheck` and the full test suite,
then streams this same `bootstrap.sh` to the droplet over SSH. Docs-only pushes
do not deploy. `workflow_dispatch` runs it on demand from the Actions tab.

The runner authenticates with a dedicated root key (`DEPLOY_SSH_KEY`) and pins
the server's host key (`DEPLOY_KNOWN_HOSTS`); `DEPLOY_HOST` is a plain repo
variable. Revoking the deploy key is one line in
`/root/.ssh/authorized_keys` and does not affect anyone's laptop key.

The manual path still works and is unchanged:

```bash
ssh -i ~/.ssh/digitalocean root@45.55.240.159 'bash -s' < deploy/bootstrap.sh
```
```

In `CLAUDE.md`, next to the deploy commands, add one line: pushing `main`
deploys automatically when deployable files change; docs-only pushes do not.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml deploy/README.md CLAUDE.md
git commit -m "ci: deploy main to the droplet through the existing bootstrap"
```

---

### Task 2: Deploy-only SSH credential

**Files:**
- Create: `~/.ssh/riskety-deploy` and `~/.ssh/riskety-deploy.pub` (local, NOT in the repo)
- Modify: droplet `/root/.ssh/authorized_keys` (append one line)
- Modify: GitHub repo secrets and variables (`gh secret set`, `gh variable set`)

**Interfaces:**
- Consumes: workflow env names from Task 1 — `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`
- Produces: a working `root@45.55.240.159` login for that key alone

- [x] **Step 1: Mint a key used by nothing else**

```bash
ssh-keygen -t ed25519 -N '' \
  -C 'github-actions-riskety-deploy-2026-08-19' \
  -f ~/.ssh/riskety-deploy
```

- [x] **Step 2: Authorise it on the droplet**

```bash
ssh -i ~/.ssh/digitalocean root@45.55.240.159 \
  "cat >> /root/.ssh/authorized_keys" < ~/.ssh/riskety-deploy.pub
```

- [x] **Step 3: Verify the new key logs in, and only as itself**

Run:
```bash
ssh -i ~/.ssh/riskety-deploy -o IdentitiesOnly=yes root@45.55.240.159 \
  'id -un && git -C /srv/riskety-rekt rev-parse --short HEAD'
```
Expected: `root` and the currently deployed short SHA

- [x] **Step 4: Load the three values into GitHub**

```bash
gh secret set DEPLOY_SSH_KEY < ~/.ssh/riskety-deploy
ssh-keyscan -t ed25519 45.55.240.159 | gh secret set DEPLOY_KNOWN_HOSTS
gh variable set DEPLOY_HOST --body 45.55.240.159
```

`ssh-keyscan` runs HERE, on a trusted machine, and its output is pinned as a
secret. The workflow never runs it.

- [x] **Step 5: Confirm what GitHub now holds**

Run: `gh secret list && gh variable list`
Expected: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, and `DEPLOY_HOST` present

---

### Task 3: Prove it end to end

**Files:**
- Modify: none required; the Task 1 commit is itself a qualifying push (it touches `.github/workflows/deploy.yml` and `deploy/README.md`)

**Interfaces:**
- Consumes: Tasks 1 and 2 complete and pushed
- Produces: a green run whose deploy log ends in bootstrap's own `==> deployed <sha>`

- [x] **Step 1: Push and watch the run**

```bash
git push origin main
gh run watch --exit-status
```
Expected: exit 0

- [x] **Step 2: Read the deploy step's tail**

Run: `gh run view --log | tail -30`
Expected: `==> deployed <short sha>` then `==> done`

- [x] **Step 3: Confirm the server actually moved**

Run:
```bash
ssh -i ~/.ssh/digitalocean root@45.55.240.159 \
  'git -C /srv/riskety-rekt rev-parse --short HEAD && systemctl is-active riskety-web riskety-slack'
```
Expected: the SHA matches `git rev-parse --short origin/main`; both services `active`

- [x] **Step 4: Confirm a docs-only push does NOT deploy**

```bash
printf '\n' >> docs/superpowers/plans/2026-08-19-github-actions-deploy.md
git commit -am "docs: whitespace" && git push origin main
gh run list --limit 3
```
Expected: no new `deploy` run for that commit

- [x] **Step 5: Commit any doc corrections found while verifying**

```bash
git add -A && git commit -m "docs: correct the deploy runbook after the first CI deploy"
```

## Self-Review

**Spec coverage:** trigger and path filter (Task 1 Step 1), Node 24 (Global Constraints, Task 1 Step 1), gates (Task 1 Step 1), key/secret/variable table (Task 2), strict host checking with no runtime keyscan (Task 1 Step 1, Task 2 Step 4), concurrency (Task 1 Step 1), bootstrap as sole upgrade path (Task 1 Step 1), failure model (bootstrap's own `set -euo pipefail`, verified in Task 3), non-goals (nothing in any task adds environments, previews, rollback, or `map:resync`).

**Placeholders:** none — every step carries the exact command or file content.

**Type consistency:** the three names `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST` are identical in Task 1's workflow, Task 2's `gh` commands, and Task 3's verification.
