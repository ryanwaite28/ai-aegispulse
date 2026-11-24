# Manual bootstrap register

Some steps cannot (or must not) be automated by the AI agent or CI. They need a human with credentials the repository never holds: cluster-admin, Infisical org admin, Cloudflare, GitLab owner, or physical access to a node. This file is the single list of those steps. PROJECT.md §11 marks them with **🛑 MANUAL (MB-xx)**.

## Stop-and-direct protocol (for AI sessions and humans)
1. Before implementing a checklist item, check whether it, or anything it depends on, references an **MB-xx** step whose status here is not **DONE**.
2. If one is open: **stop**. Do not stub, fake, or work around it, and do not ask for the credential itself. Tell the operator:
   - which MB step is needed and why it blocks this work;
   - the exact commands and UI actions below;
   - what to report back. Report facts such as slugs, names, IDs and "done", **never secret values**.
3. After the operator confirms, run the step's **Verify** commands (read-only), update the status and evidence here, then continue.
4. Never paste a secret into a prompt, a doc, a commit, or a tool argument. Secrets go straight from the operator's terminal into Infisical or the cluster. When a step involves a login, report the result ("done") instead of pasting terminal output. If a secret is pasted by mistake, rotate it (it is in the conversation transcript even when the session log redacts it).

## Status
| ID | Step | Blocks | Owner | Status |
|---|---|---|---|---|
| MB-01 | Storage-node data SSD + node roles (ADR-0015) | Phase 9 data stores | cluster admin (node sudo) | **DONE** 2026-11-22 ([evidence](../evidence/platform-node-roles.md)) |
| MB-02 | Local OTLP header in `.env` | local traces (Phase 1 exit) | operator | **DONE** 2026-11-23 ([phase-01e](../evidence/phase-01e.md)) |
| MB-03 | Infisical CLI on the workstation + `svc_admin` login | MB-06 seeding, rotation | operator | **DONE** 2026-11-23 (CLI 0.45.14) |
| MB-04 | Confirm Infisical environment slugs; scope `svc_admin` | MB-06, all InfisicalSecret CRs | Infisical org admin | **DONE** 2026-11-23 (slugs `dev`/`prod`; `svc_admin` stays org admin — accepted homelab risk, see infisical.md) |
| MB-05 | Install the Infisical Kubernetes Operator | Phase 9 secret sync | cluster admin | **DONE** 2026-11-23 (chart `secrets-operator` 0.11.18, namespace `infisical-operator`; 8 CRDs, controller Available) |
| MB-06 | Seed Infisical folders + generated secrets (agent prepares, operator runs) | Phase 9 deploys | operator (with agent) | **DONE** 2026-11-23: dev and prod each `0 present, generated 60, deferred 43` (43 = 39 reference keys for Phase 9 + 4 external keys for their owners: OTLP token, Anthropic key, ntfy token, previous JWT key); optional check: a re-run dry run reports `would generate 0` |
| MB-07 | Create AegisPulse namespaces, quotas, default-deny, CI deployer SAs (§9.3 1–2) | MB-08, Phase 9 | cluster admin | OPEN (Phase 9) |
| MB-08 | Operator machine identities `aegispulse-operator-dev` / `-prod` (read-only, Kubernetes Auth) | Phase 9 secret sync | Infisical admin + cluster admin | OPEN (needs MB-05, MB-07) |
| MB-09 | RabbitMQ vhosts `aegispulse-dev`/`-prod`, per-service users, `aegis_topology` (§9.3 5) | Phase 9 | RabbitMQ admin | OPEN (Phase 9) |
| MB-10 | OpenObserve org/streams + ingestion token into Infisical (§9.3 7) | Phase 9 observability | OpenObserve admin | OPEN (Phase 9) |
| MB-11 | Cloudflare tunnel hostnames + WAF on both zones (§9.3 6) | Phase 9/10 ingress | Cloudflare admin | OPEN (Phase 9) |
| MB-12 | GitLab: protections, `dev`/`prod` environments, CI variables, schedules (§9.3 8) | Phase 10 pipeline | GitLab owner | OPEN (Phase 10) |
| MB-13 | cosign key pair → GitLab variables; public key committed (§9.3 9) | Phase 10 sign/deploy | GitLab owner | OPEN (Phase 10) |
| MB-14 | k3s: upgrade the server to the agents' minor; add Tailscale IP to `tls-san` (K3S_CONTEXT §8) | cluster hygiene | cluster admin | OPEN (outside AegisPulse) |
| MB-15 | First `PLATFORM_ADMIN` in dev/prod (FR-TEN-09): set `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` in Infisical `/registry`, re-run `seed.py` (adds the password), run the bootstrap Job at first deploy, then log in and change the password | Phase 9/10 first deploy | operator | OPEN (Phase 9) |

Infisical steps MB-03 to MB-06 and MB-08 are detailed in [infisical.md](infisical.md).

## MB-07 — Namespaces and CI deployer (Phase 9)
Scripted as idempotent `deploy/bootstrap/*.sh` in Phase 9 (§9.3 1–2). The operator runs them with cluster-admin. The agent never holds cluster-admin.
- **Report back:** "MB-07 done". The deployer tokens go straight into GitLab variables (MB-12), never through the agent.
- **Verify:** `kubectl get ns aegispulse aegispulse-dev`; `kubectl -n aegispulse-dev get sa aegispulse-ci-deployer`.

## MB-09 — RabbitMQ (Phase 9)
On the shared cluster RabbitMQ, create:
- vhosts `aegispulse-dev` and `aegispulse-prod`;
- the `aegis_topology` user;
- one user per runtime per vhost (dev users suffixed `-dev`), with the permission regexes from `deploy/compose/init/rabbitmq/init.sh` (§5.7.3).

Passwords are generated in Infisical (MB-06) and read from there by the admin script, never typed into prompts.
- **Verify:** `rabbitmqctl list_permissions -p aegispulse-dev`, which lists names and regexes only.

## MB-10, MB-11, MB-12, MB-13
Follow PROJECT.md §9.3 steps 6–9. The agent prepares the scripts, manifests and variable lists, and the owner performs the action in the respective UI or CLI. Each step reports back only names and "done".
