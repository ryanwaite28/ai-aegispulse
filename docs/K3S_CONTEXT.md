# K3s + GitLab Homelab: Setup Retro

A retrospective on how this cluster got from bare metal to a working
self-hosted GitLab + CI/CD + Container Registry stack, written as both a
record of what happened and a teaching document for next time — whether
"next time" is rebuilding this cluster from scratch, or just understanding
why it's shaped the way it is.

**Scope note on accuracy:** the cluster (k3s, ingress-nginx, GitLab CE,
Headlamp) already existed when this session started. Steps 0–5 below are
reconstructed from what the cluster's current state implies (Helm release
history, manifests on disk, resource configuration) — the exact original
commands weren't captured live. Steps 6 onward (GitLab Runner, Container
Registry) were done and verified step-by-step in this session, including
every mistake and fix, and are described in full fidelity.

---

## 1. The Journey: Bare Metal → Current State

### Step 0 — Bare metal prerequisites
A single physical machine (`elitedesk-800`, Ubuntu 26.04 LTS, 4 vCPU, ~24GiB
RAM) — no VM layer, no cloud provider. This matters for everything after:
**this cluster's entire capacity is one machine's capacity.** There is no
"add a node" escape hatch without buying another machine.
*(Update: two agents were added later, `optiplex` and then `optiplex-tower`.
Current roles are in Part 2 §1.1.)*

### Step 1 — Install k3s
k3s is Rancher's lightweight single-binary Kubernetes distribution —
API server, scheduler, controller-manager, kubelet, containerd, and a
bundled SQLite-or-etcd datastore all in one process, versus stock
Kubernetes' many separate components. For a single-node homelab box, this
is the right call: full Kubernetes API compatibility with a fraction of
the operational overhead of `kubeadm`.

Standard install is a single command:
```bash
curl -sfL https://get.k3s.io | sh -
```
This also installs a bundled `local-path` StorageClass and a Traefik
ingress controller by default — **this cluster does not use the bundled
Traefik**; a standalone `ingress-nginx` was installed instead (Step 4).

### Step 2 — kubectl access
k3s installs its own `kubectl` (actually a symlink to the `k3s` binary,
invoked as `k3s kubectl`) which defaults to reading
`/etc/rancher/k3s/k3s.yaml` — a **root-only** file. This is a real gotcha,
hit directly in this session (see §4). The practical fix: copy that file
out to `~/.kube/config` for the operating user, and either export
`KUBECONFIG=~/.kube/config` in the shell profile, or pass it explicitly per
command.

### Step 3 — Install Helm
Helm is the de-facto package manager for Kubernetes (full explanation in
§9). Installed once, used to install every Helm-packaged component below.

### Step 4 — Standalone `ingress-nginx`
Installed via Helm as the `external-nginx` release in the `ingress-nginx`
namespace, registered as the **default** IngressClass under the name
`nginx-external`. This is the single entry point for all HTTP traffic into
the cluster — every app's Ingress resource references
`ingressClassName: nginx-external`.

### Step 5 — Cloudflare Tunnel + DNS
`rmwhs.com` is proxied through Cloudflare (free tier). A `cloudflared`
tunnel exposes the cluster's ingress to the internet without opening any
inbound firewall ports on the homelab — Cloudflare's edge terminates TLS
and forwards plain HTTP to the tunnel, which is why every Ingress in this
cluster serves HTTP only (`ssl-redirect: "false"`) rather than doing its
own TLS. Each app gets its own subdomain (`gitlab.rmwhs.com`,
`headlamp.rmwhs.com`, etc.), proxied ("orange-clouded") in Cloudflare DNS.

### Step 6 — Deploy GitLab CE
Deployed as a **raw Kubernetes manifest**
([manifest/gitlab-omni-ce.yaml](k8s-infrastructure/manifest/gitlab-omni-ce.yaml)) —
a single `gitlab/gitlab-ce:latest` omnibus container (GitLab's
all-in-one image bundling Rails, PostgreSQL, Redis, Gitaly, Sidekiq,
Registry, and its own internal nginx) with two PVCs (`/etc/gitlab` config,
`/var/opt/gitlab` data) on `local-path` storage, tuned down for a
resource-constrained box (`postgresql['shared_buffers'] = '256MB'`,
`sidekiq['max_concurrency'] = 10'`, `puma['worker_processes'] = 2`), and an
Ingress at `gitlab.rmwhs.com`.

**Note:** there's also a [helm/gitlab-ce-values.helm.yaml](k8s-infrastructure/helm/gitlab-ce-values.helm.yaml)
in the repo for GitLab's official Helm chart — that's an alternate path
that isn't actually deployed. The raw manifest is what's live. Worth
cleaning up or clearly labeling as unused so a future you doesn't get
confused about which is authoritative.

### Step 7 — Deploy Headlamp (cluster dashboard)
Installed via Helm (`my-headlamp` release), with OIDC login wired to
GitLab itself (`issuerURL` pointing at `gitlab.rmwhs.com`) so cluster
access uses the same identity as everything else, backed by a
`ClusterRoleBinding` granting `cluster-admin` to the operator's GitLab
email. Ingress at `headlamp.rmwhs.com`.

### Step 8 — Deploy GitLab Runner *(this session, full detail in §4)*
Installed via the official `gitlab-runner` Helm chart into a dedicated
`gitlab-runner` namespace, configured with the `kubernetes` executor so
CI jobs run as ephemeral pods on this same cluster rather than needing a
separate build machine. This took several iterations to get right — see
§4 for the actual bugs hit and fixed.

### Step 9 — Enable Container Registry + Package Registry *(this session)*
GitLab's Container Registry and Package Registry were not enabled on the
initial install. Enabled by extending the same omnibus manifest with
`registry_external_url`, a second Ingress for `registry.rmwhs.com` routed
to the *same* GitLab pod (differentiated by HTTP `Host` header inside
GitLab's own bundled nginx — no second container needed), and
`gitlab_rails['packages_enabled'] = true`. Also required raising
`client_max_body_size` at two separate nginx layers before it actually
worked end-to-end — see §4.

### Step 10 — Verify end-to-end
A real project (`demo/gitlab-runner-demo`) exercised the whole chain: push
→ GitLab Runner picks up the job → kaniko builds a Docker image inside an
ephemeral pod (no Docker-in-Docker) → pushes to
`registry.rmwhs.com/demo/gitlab-runner-demo` → visible in the GitLab
Container Registry UI. This is the point the cluster is considered "done"
for this retro — a real GitLab-hosted CI/CD pipeline building and shipping
container images, entirely self-hosted on one machine.

---

## 2. What Went Right

- k3s + standalone ingress-nginx + Cloudflare Tunnel is a genuinely solid,
  low-maintenance combo for a single-node homelab — no inbound firewall
  rules needed, TLS handled entirely at the edge, one `IngressClass` for
  everything.
- The GitLab Runner registered and picked up jobs correctly on the very
  first attempt where the config was actually valid — the Helm chart's
  defaults are sane once you get past its handful of sharp edges (below).
- Enabling Container Registry on an omnibus GitLab install didn't require
  a second container/pod — GitLab's bundled nginx can virtual-host a second
  external URL on the same port, keyed off the `Host` header. One pod,
  two public hostnames.
- Every fix in this session was verified **inside** the cluster before
  being declared done (internal `curl -H "Host: ..."` tests, `gitlab-ctl
  status`, grepping the actual rendered config file) rather than trusting
  that `helm upgrade`/`kubectl apply` succeeding meant the fix worked. This
  caught nothing extra this time, but it's the habit that would have.

---

## 3. What Went Wrong (and had to be re-iterated)

This is the part worth actually reading closely — every one of these was a
real, live mistake made and fixed in this session, not a hypothetical.

### 3.1 Stale placeholder value in the runner's `values.yaml`
The first `gitlab-runner-values.helm.yaml` was drafted with
`gitlabUrl: https://gitlab.example.com/` as an illustrative placeholder,
and `helm install` ran against it before the placeholder was swapped for
the real `gitlab.rmwhs.com`. Result: the runner pod registered against a
hostname that doesn't exist, failing DNS resolution
(`dial tcp: lookup gitlab.example.com ... no such host`) in a crash loop.
**Lesson:** never `helm install` off a values file with an unverified
placeholder still in it — read the file back before applying, every time.

### 3.2 `helm install` vs. `helm upgrade`
After fixing the URL, re-running `helm install` with the same release name
failed outright: `cannot reuse a name that is still in use`. The first
(broken) install had still *succeeded* from Helm's point of view — a
release existed, just misconfigured. The fix is `helm upgrade`, not a
repeated `install`. **Lesson:** once a release exists, every subsequent
change is an `upgrade`; `install` is a one-time operation per release name.

### 3.3 The TOML nesting bug — the most instructive failure of the session
The runner's `[[runners]]` TOML config had:
```toml
[runners.kubernetes]
  namespace = "gitlab-runner"
  image = "alpine:latest"
  ...
  [runners.kubernetes.node_selector]
  cpu_request = "200m"
  memory_request = "128Mi"
  cpu_limit = "1"
  memory_limit = "2Gi"
```
The intent was to set **resource requests/limits** for job pods. What
actually happened: in TOML, once you open a sub-table header
(`[runners.kubernetes.node_selector]`), every following key belongs to
*that* table until the next header appears. Since nothing closed it, all
four resource keys became entries in `node_selector` — which Kubernetes
interprets as **required node labels**, not resource sizing. The generated
Pod spec ended up with:
```
Node-Selectors: cpu_limit=1, cpu_request=200m, memory_limit=2Gi, memory_request=128Mi
```
No real node has labels like that, so every job pod sat `Pending` forever
with `didn't match Pod's node affinity/selector` — a message that gives
almost no hint that the real bug is a config *authoring* mistake, not a
cluster capacity problem. **This was caught by `kubectl describe pod` and
reading the `Node-Selectors:` line closely** — the fix was simply removing
the stray `[runners.kubernetes.node_selector]` header so the four keys
landed back under `[runners.kubernetes]` directly.
**Lesson:** TOML table scoping is easy to get wrong when hand-nesting keys
under a chart's `runners.config` block, and the failure mode it produces
(`Pending`, node affinity mismatch) looks nothing like a syntax error —
always `kubectl describe pod` on anything stuck `Pending`, don't guess.

### 3.4 Orphaned job pod after the fix
Fixing §3.3 required a `helm upgrade`, which rolled the runner **manager**
pod. But the already-stuck job pod it had created wasn't owned by any
controller (the kubernetes executor creates bare Pods, not
Deployment-managed ones) — so when the old manager pod terminated, that
Pending pod was simply abandoned, not cleaned up. It had to be deleted by
hand (`kubectl delete pod`). **Lesson:** ephemeral CI job pods aren't
self-cleaning if the runner manager that created them disappears mid-job —
check for orphans after any runner manager restart during an active job.

### 3.5 `413 Request Entity Too Large` on the first registry push
Enabling the registry (§Step 9) wasn't enough on its own — the first real
`docker push` (via kaniko) failed with a 413 from nginx. Root cause: nginx
has a default `client_max_body_size` of 1MB, and Docker registry pushes
upload blobs via **chunked PATCH requests**, which trip that default even
for genuinely small payloads. The nasty part: this limit exists at **two
independent layers** in this cluster's traffic path — the k3s
`ingress-nginx` controller in front, *and* GitLab's own bundled registry
nginx behind it — and both needed the same fix
(`proxy-body-size: "0"` annotation on the Ingress; `registry_nginx['client_max_body_size'] = '0'`
in the omnibus config). Fixing only one still failed. **Lesson:** when
multiple reverse-proxy layers sit in a request's path, a body-size (or
timeout, or buffering) fix usually needs applying at *every* layer, not
just the one closest to the error message.

### 3.6 A related, permanent, non-fixable constraint discovered along the way
While debugging §3.5, a **separate, unrelated** limit came up: Cloudflare's
free/Pro tier caps proxied request bodies at 100MB, enforced at their edge,
before traffic even reaches the tunnel — this cannot be configured away
from this side at all. It wasn't the cause of the 413 (the test image was
a few KB), but it's a real ceiling for the future: any single Docker image
layer, or any single git/LFS push, over 100MB will hit it. **Lesson:**
don't stop debugging once *a* plausible cause is found — confirm the
actual cause, because a similarly-shaped but unrelated constraint can be
sitting right behind it waiting for a much later, more confusing failure.

### 3.7 `kubectl` silently reading the wrong kubeconfig
Every `kubectl` invocation in this session needed
`KUBECONFIG=~/.kube/config` prefixed, because plain `kubectl` (symlinked to
the k3s binary) defaults to a root-owned file the operating user can't
read. This isn't a bug introduced this session, but it's worth calling out
because it silently produces a *permission denied*, not a helpful "wrong
config" message — easy to misdiagnose as a cluster access problem.

---

## 4. Troubleshooting Playbook

Techniques that actually resolved something in this session, worth
reaching for first next time something's broken:

| Symptom | First move |
|---|---|
| Pod stuck `Pending` | `kubectl describe pod <name>` → read the `Events:` section and `Node-Selectors:`/`Tolerations:` — the scheduler always states *why* it can't place a pod |
| Pod `CrashLoopBackOff` / restarting | `kubectl logs <pod> --previous` (the *previous* crashed instance, not the fresh restart) |
| "It should be fixed but isn't" | Don't trust the apply succeeded — exec into the pod and check the *actual rendered config file* (`grep` for the setting you just set). A Helm/kubectl success message only means the API accepted your object, not that the workload picked it up correctly |
| Ambiguous error from a chain of proxies | Look for identifying details in the error body (server name, injected scripts/branding) to figure out *which* hop actually generated it, rather than assuming the outermost or innermost layer |
| `helm install` fails post-hoc | Check `helm list -A` first — if the release already exists, you want `helm upgrade`, not another `install` |
| Config change seems to not take effect | Check whether the workload actually restarted (`kubectl get pods`, compare `AGE`) — some controllers don't restart pods on a ConfigMap/env change without a rollout trigger |
| Need to test a Host-header-routed service without DNS in place yet | `kubectl exec` into a pod on the same network and `curl -H "Host: real.domain.com" http://localhost:<port>/path` — proves the routing logic works independent of external DNS |
| `kubectl` permission denied reading kubeconfig | Check what `kubectl` actually resolves to (`type kubectl`) — on k3s it may be a symlink defaulting to a root-only file, not your user's `~/.kube/config` |
| `x509: certificate is valid for …, not <tailnet address>` from a remote `kubectl` | The API server certificate doesn't list the Tailscale address. Per command: `kubectl --tls-server-name=<an address the cert does list>` (verification stays on). Permanent fix: add the tailnet address/name under `tls-san` in the k3s server config and restart k3s. **Never** use `--insecure-skip-tls-verify` |
| Storage pod `Pending` with `didn't tolerate` / `didn't match node selector`, or a node `NotReady` after a reboot | Check the node roles (`kubectl get nodes -L node-role.kubernetes.io/storage,dedicated`). On the storage node, `findmnt /mnt/data` — if the data SSD didn't mount, `k3s-agent` won't start, on purpose (§1.1) |

### 4.1 Access for troubleshooting
- `kubectl` from the operator workstation: `KUBECONFIG=~/.kube/config`
  points at the control plane over Tailscale.
- SSH: the operator's SSH config has per-node host aliases, including
  `--vpn` variants that go over Tailscale (for example `elitedesk--vpn`,
  `optiplex-tower--vpn`). Use those names. Never write hostnames, IPs,
  users or keys into project repos or docs.
- `sudo` on the nodes asks for a password interactively. Automation and AI
  agents can run read-only diagnostics (`lsblk`, `findmnt`, `journalctl`
  where permitted, `systemctl status`) but hand privileged commands to the
  operator to run.
- Prefer `kubectl` for anything the API can answer. Use SSH for host-level
  concerns: disks, mounts, the k3s service, the kernel.

---

## 5. Best Practices Distilled

- **Read config files back before applying them.** Every real bug this
  session (§3.1, §3.3) was a mistake sitting in a YAML/TOML file that a
  careful re-read would have caught before `helm upgrade` ever ran.
- **`kubectl describe`, not just `kubectl get`, is the actual debugging
  tool.** `get` tells you state; `describe`'s `Events:` section tells you
  *why* that state is what it is.
- **Verify inside the cluster, not just at the API layer.** A successful
  `kubectl apply`/`helm upgrade` only confirms the API server accepted your
  object — confirm the running process actually picked up the change.
- **Namespace and resource-limit everything**, especially on a
  single-node, fixed-capacity cluster where one unbounded pod can starve
  the whole box (this is codified as a hard requirement in
  [KUBERNETES_GITLAB_CONTEXT.md](KUBERNETES_GITLAB_CONTEXT.md)).
- **No Docker-in-Docker / `privileged: true`** for image builds — kaniko
  ran cleanly the entire session with zero privilege escalation.
- **Treat multi-hop reverse-proxy chains as N independent places a limit
  can be enforced**, not one. Fix the whole chain, verify the whole chain.
- **Keep a living document** (this file, and
  [KUBERNETES_GITLAB_CONTEXT.md](KUBERNETES_GITLAB_CONTEXT.md)) that
  reflects the cluster's *actual, verified* state — not the aspirational
  state. The stale "registry not enabled" note that had to be corrected
  mid-session is a small example of docs drifting from reality the moment
  they're not actively kept in sync.

---

## 6. How to Think in Kubernetes

Kubernetes is fundamentally a **declarative, reconciling control system**,
not a script runner. The mental model that makes everything else make
sense:

1. **You declare desired state** — a YAML manifest saying "there should be
   a Deployment named `myapp` running 2 replicas of image `X`."
2. **The API server stores that desired state** — durably, in **etcd**
   (more on this below).
3. **Controllers continuously watch** the gap between desired state (what
   you declared) and actual state (what's really running), and act to
   close that gap — create a missing pod, restart a crashed one, delete an
   extra one.
4. **This loop never stops.** It's not "run this once" — it's "keep this
   true, forever, until I declare something different." This is why
   deleting a Pod that belongs to a Deployment doesn't actually remove it
   for long: the ReplicaSet controller notices the gap and creates a
   replacement within moments.

Everything in Kubernetes is an **object** with two parts: a `spec` (what
you want) and a `status` (what's currently observed). Reading a manifest
is reading an intention, not a command.

**Where etcd fits in:** etcd is **not** something you create manifests
for — it's the cluster's own backing datastore, the single source of
truth for every object's state. The API server is the only thing that
talks to it directly; you never touch it yourself. In stock Kubernetes,
etcd is its own clustered service (and the thing that makes multi-master
HA hard to get right); in k3s, by default it's swapped for embedded
SQLite on a single-node setup like this one — same role, lighter weight,
same important fact: **if it's lost, the cluster's entire memory of what
should exist is lost with it.** Backing it up matters more than backing up
any individual manifest, because the manifests you `kubectl apply` are
reproducible from source control — etcd's actual current state (including
anything that changed via `kubectl edit`, autoscaling, etc.) is not.

---

## 7. Kubernetes Kinds Cheatsheet

| Kind | What it is | Use it when |
|---|---|---|
| **Namespace** | A logical partition of the cluster — its own scope for names, RBAC, resource quotas | Always — one per app/tenant, per this cluster's own hard rule |
| **Pod** | The smallest deployable unit: one or more containers sharing network + storage | Rarely created directly — almost always managed by a Deployment/Job/etc. instead |
| **Deployment** | Manages a ReplicaSet, which manages Pods; gives you declarative rollout, rollback, and self-healing | The default choice for any stateless, long-running app |
| **ReplicaSet** | Ensures N identical Pod replicas exist | Almost never created directly — it's what a Deployment manages underneath |
| **StatefulSet** | Like a Deployment, but each replica gets a stable identity/name and its own persistent volume | Databases, queues, anything where pod identity or per-instance storage matters |
| **DaemonSet** | Runs exactly one pod per (matching) node | Node-level agents — log shippers, monitoring agents, CNI components. Not used much on a 1-node cluster, matters more as nodes are added |
| **Job** | Runs a pod to completion, once (or N times) | One-off or batch tasks — migrations, backups, data processing |
| **CronJob** | Runs a Job on a schedule | Recurring batch tasks — nightly backups, scheduled reports |
| **Service** | A stable virtual IP/DNS name that load-balances across a set of Pods (which have ephemeral IPs) | Any time one thing needs to reliably reach another — internal service discovery |
| **Ingress** | L7 HTTP(S) routing rules from the outside world into Services, by hostname/path | The front door for any web-facing app — requires an Ingress *controller* (like `ingress-nginx`) actually installed to do anything |
| **ConfigMap** | Non-secret key/value configuration, injected as env vars or mounted files | App configuration that isn't sensitive — feature flags, URLs, tuning params |
| **Secret** | Same shape as a ConfigMap, but for sensitive values (base64-encoded at rest, access-controlled via RBAC) | Passwords, tokens, API keys the *running pod* needs |
| **PersistentVolumeClaim (PVC)** | A request for storage, satisfied by a PersistentVolume via a StorageClass | Anything that needs to persist data across pod restarts |
| **PersistentVolume (PV)** | The actual provisioned storage backing a PVC | Rarely created directly on a cluster with dynamic provisioning (`local-path` auto-creates these per PVC) |
| **StorageClass** | Defines *how* storage gets dynamically provisioned when a PVC asks for it | Set once per storage backend; apps just reference it by name |
| **ServiceAccount** | An identity that Pods (or CI pipelines) authenticate to the API server as | Any workload/pipeline that needs to talk to the Kubernetes API itself, scoped narrowly per §3.5 of the deployment guide |
| **Role / RoleBinding** | Grants a set of permissions, scoped to one namespace, to a subject (ServiceAccount/User) | Least-privilege access within a single app's namespace |
| **ClusterRole / ClusterRoleBinding** | Same as above, but cluster-wide | Cluster-admin-style access (used for Headlamp's OIDC binding), or genuinely cluster-scoped resources |
| **HorizontalPodAutoscaler** | Automatically scales replica count based on observed metrics (CPU, memory, custom) | Variable-load apps on a cluster with room to scale into — not particularly useful on this fixed single-node box today |

**etcd** deliberately isn't in this table — it's not a manifest kind you
author, it's the cluster's own datastore underneath everything above (see
§6).

---

## 8. What Is Helm, and When to Use It

Helm is Kubernetes' package manager. A **chart** is a versioned, templated
bundle of Kubernetes manifests plus a `values.yaml` of parameters —
`helm install` renders the templates with your values and applies the
result as a tracked **release**, which Helm can then upgrade, roll back,
or uninstall as a unit.

**What it actually buys you over plain manifests:**
- Parameterization — one chart, many environments, via different
  `values.yaml` files (exactly what `gitlab-runner-values.helm.yaml` is)
- A tracked release history — `helm upgrade`/`helm rollback` know what
  changed between versions
- Reuse of complex, already-solved deployment logic for third-party
  software (GitLab, ingress-nginx, GitLab Runner, Headlamp all shipped as
  Helm charts by their maintainers — nobody hand-wrote their manifests
  from scratch)

**When to reach for it vs. plain manifests** — this cluster already draws
the line correctly and it's worth keeping:
- **Helm** for anything third-party/complex that already ships an
  official chart: `ingress-nginx`, `gitlab-runner`, `headlamp`. Don't
  reinvent what the maintainer already solved.
- **Plain manifests** for anything you own and fully understand, where
  the manifest count is small and templating buys you nothing: the GitLab
  CE deployment itself, and — per
  [KUBERNETES_GITLAB_CONTEXT.md](KUBERNETES_GITLAB_CONTEXT.md) — every
  future app deployed onto this cluster. A future app should only reach
  for Helm if it genuinely needs multi-environment templating; most
  single-app deployments don't.

---

## 9. Conclusion: What Kubernetes Is — and Isn't

**What it is:** a declarative reconciliation engine for running
containerized workloads — it watches for drift between what you've said
should exist and what actually does, and continuously corrects it. That
gets you, for free: self-healing (crashed pods come back), rolling
updates and rollbacks, service discovery that survives pods moving
around, and — critically for this cluster's actual motivating use case —
**a single, consistent deployment vocabulary** that every future app can
speak, regardless of what language or framework it's written in. That
last point is the real payoff here: the value of this whole setup isn't
really "orchestration at scale," it's "every project that lands on this
GitLab instance gets the exact same, predictable path to production,"
which is precisely what
[KUBERNETES_GITLAB_CONTEXT.md](KUBERNETES_GITLAB_CONTEXT.md) codifies.

**What it isn't:** a source of high availability by itself (this cluster
is one machine — Kubernetes running on it doesn't change that a reboot
takes everything down), a performance optimization (it adds scheduling
and networking overhead, it doesn't remove it), or a substitute for
actually understanding the systems running on top of it. Nearly every
failure in this session (§3) came from Kubernetes/Helm/nginx configuration
subtlety, not from the applications themselves — that operational tax is
real and has to be budgeted for, not hand-waved away because "it's just
YAML."

**When it's worth that tax:** when you have — or expect to have — more
than one service that needs deploying, and you want them all deployed,
observed, and secured the same predictable way. A single static site or a
lone cron job doesn't need Kubernetes; a systemd unit or a plain Docker
container is less machinery for the same outcome. This cluster clears
that bar specifically *because* it's meant to host GitLab itself plus an
open-ended set of future apps through one shared CI/CD and ingress
convention — the standardization is the actual return on the complexity,
not raw scale, and definitely not high availability, which this
single-node setup explicitly doesn't have and was never trying to solve.

---

# Kubernetes + GitLab Deployment Guide

This is the canonical reference for deploying any application onto this k3s
cluster. It exists so that every project — regardless of language or
framework — ships to production the same predictable way, using the same
CI/CD system, the same ingress conventions, and the same secrets model.

If you are setting up deployment for a new app, read this document fully
before writing your `.gitlab-ci.yml` or Kubernetes manifests.

---

## 1. Cluster Overview

| | |
|---|---|
| Distro | k3s — three nodes: control plane `elitedesk-800`, app-compute worker `optiplex`, storage-dedicated agent `optiplex-tower` (see [§1.1](#11-node-roles-and-scheduling)) |
| Capacity | `elitedesk-800`: 4 vCPU / ~24 GiB RAM (control plane, shared platform services, spill-over app pods). `optiplex`: 4 vCPU / ~15 GiB RAM, ~100 GB OS disk (**app/stateless pods first**). `optiplex-tower`: 8 vCPU / ~30 GiB RAM, 1 TB data SSD (**stateful storage workloads only**). Plan app capacity against `optiplex` + `elitedesk-800`, storage against `optiplex-tower`. |
| Network | every node and the operator workstation are on the homelab Tailscale tailnet; remote `kubectl`/SSH go over it (§4.1) |
| Ingress controller | standalone `ingress-nginx`, class name **`nginx-external`** (default) |
| Storage class | `local-path` (Rancher local-path-provisioner, default, `WaitForFirstConsumer`, **ReadWriteOnce only**) |
| DNS / domain | `rmwhs.com`, proxied through Cloudflare |
| TLS termination | at Cloudflare edge — origin ingress serves **plain HTTP**, not HTTPS (`ssl-redirect: "false"`) |
| CI/CD | self-hosted GitLab CE at `https://gitlab.rmwhs.com/` |
| Runners | GitLab Runner (Helm chart, `kubernetes` executor) in the `gitlab-runner` namespace, deployed via [helm/gitlab-runner-values.helm.yaml](k8s-infrastructure/helm/gitlab-runner-values.helm.yaml) |
| Cluster admin UI | Headlamp at `https://headlamp.rmwhs.com/`, OIDC via GitLab |

Because each node has **fixed capacity and a fixed role**, and no node is a
standby for another, every requirement and best practice below exists to keep
the cluster stable under that ceiling, not because of arbitrary policy.

### 1.1 Node roles and scheduling

| Node | Role | Labels | Taints | Runs |
|---|---|---|---|---|
| `elitedesk-800` | control plane + shared platform + spill-over compute | `node-role.kubernetes.io/control-plane=true` | none | GitLab, runner, ingress, monitoring, Infisical, RabbitMQ, OpenObserve (all with PVCs already bound here); app pods only when `optiplex` is full |
| `optiplex` | **app-compute worker** | `node-role.kubernetes.io/worker=true` | none | app Deployments, workers, CronJobs, Jobs — stateless pods prefer this node |
| `optiplex-tower` | **storage-dedicated** agent | `node-role.kubernetes.io/storage=true`, `dedicated=storage` | `dedicated=storage:NoSchedule` | database pods (PostgreSQL, MongoDB), Redis/cache pods, object storage pods — and nothing else. Data lives on its 1 TB SSD |

Why this split (decision record: AegisPulse ADR-0015): `local-path`
volumes are node-bound, so data has to sit where the big disk is, and
databases turn the tower's spare RAM into page cache. Keeping app pods off
the storage node stops them competing with databases for memory and disk
I/O. Moving app pods to `optiplex` takes load off the node that also runs
the control plane, GitLab and CI. `optiplex` held no PVs when its role
changed, so nothing was stranded.

The taint keeps ordinary pods off `optiplex-tower`. Cluster-wide DaemonSets that
tolerate all taints (node-exporter, OpenObserve collector) still run there,
which is intended. The taint is `NoSchedule`, not `NoExecute`, so pods
already running there were not evicted when the taint was added.

**Storage workloads must opt in with both a toleration and a node
selector.** The toleration only *permits* scheduling on `optiplex-tower`. The
node selector is what *pins* the pod there:

```yaml
spec:
  template:
    spec:
      nodeSelector:
        dedicated: storage
      tolerations:
        - key: dedicated
          operator: Equal
          value: storage
          effect: NoSchedule
```

Rules:
- Only stateful data stores (databases, caches, object storage) get this
  stanza. App servers, workers, gateways, and jobs must **not** tolerate
  the `dedicated=storage` taint.
- Add the stanza **before the first deploy** of a stateful workload.
  `local-path` PVCs are `WaitForFirstConsumer`: the PV is created on the
  node where the first pod lands, and the pod stays tied to that node for
  good. If a database starts once on `elitedesk-800`, its PVC is stuck
  there. Moving it means backup, delete the PVC, then restore.
- `local-path` data for storage pods lives on `optiplex-tower`'s 1 TB SSD.
  The SSD (ext4, label `k3s-data`) is mounted at `/mnt/data`, and
  `/mnt/data/k3s-storage` is bind-mounted over the default local-path
  directory `/var/lib/rancher/k3s/storage`. The provisioner config is
  unchanged; k3s re-applies its `local-path-config` on restart, so editing
  it would not stick. `k3s-agent` has `RequiresMountsFor=` on both paths,
  so if the SSD is missing the node goes NotReady rather than writing
  database files to the OS disk. Backups must be copied **off** this node.
- Storage pods still declare requests and limits (§2.5). Budget them
  against `optiplex-tower`'s ~30 GiB, not against the compute nodes.
- Pre-existing stateful infrastructure (GitLab's bundled data, Infisical's
  PostgreSQL/Redis) still runs on `elitedesk-800` with PVCs bound there. It
  stays there until someone migrates it on purpose.

Stateless app pods should *prefer* the worker, so they fill `optiplex`
before landing next to GitLab on the control plane:

```yaml
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - { key: node-role.kubernetes.io/worker, operator: In, values: ["true"] }
```

A stateless workload that still owns a PVC (a cache volume, say) should use
`requiredDuringScheduling…` instead, so the PVC binds to a known node.

To reproduce or audit the node setup (scripted and idempotent in AegisPulse
`deploy/bootstrap/10-storage-node-disk.sh` and `20-node-roles.sh`):

```bash
# on optiplex-tower, as root: prepare the data SSD (asks for typed confirmation before wiping)
sudo bash 10-storage-node-disk.sh /dev/disk/by-id/<whole-disk-id>
# from the workstation
kubectl label node optiplex-tower node-role.kubernetes.io/storage=true dedicated=storage --overwrite
kubectl taint node optiplex-tower dedicated=storage:NoSchedule --overwrite
kubectl taint node optiplex dedicated=storage:NoSchedule-
kubectl label node optiplex node-role.kubernetes.io/storage- dedicated- node-role.kubernetes.io/worker=true
kubectl get nodes -L node-role.kubernetes.io/storage,node-role.kubernetes.io/worker,dedicated
```

`optiplex-tower` also has a legacy NTFS disk from a previous OS install. It is
not used by the cluster; never format or mount it for app data.

---

## 2. Hard Requirements

These are non-negotiable. A deployment that violates any of these should be
treated as broken, not "good enough."

### 2.1 Ingress must use a subdomain — never the apex domain
- Every app is reachable at `<app>.rmwhs.com`.
- **No app may bind to the apex `rmwhs.com` domain.** The apex is reserved.
- Pick a short, unambiguous subdomain that matches the project name (e.g.
  `inventory-api.rmwhs.com`, not `api.rmwhs.com` — the latter doesn't scale
  once a second API shows up).
- `ingressClassName` must always be `nginx-external`. There is no other
  ingress controller on this cluster.
- Ingress serves plain HTTP (`nginx.ingress.kubernetes.io/ssl-redirect:
  "false"`) — TLS is handled by Cloudflare in front, not by the ingress
  itself. Don't add cert-manager annotations; there is no cert-manager
  installed on this cluster currently.

### 2.2 CI/CD is GitLab, exclusively
- Every deployable project lives in this GitLab instance and ships a
  `.gitlab-ci.yml` at its root. No other CI system (GitHub Actions, Jenkins,
  etc.) is used to build or deploy to this cluster.
- Pipelines run on the shared k3s-backed runner (tags: `default`,
  `generic`) registered in the `gitlab-runner` namespace.

### 2.3 Every app produces a Docker image pushed to the GitLab Container Registry
- Every deployable project must have a `Dockerfile` and a CI stage that
  builds an image and pushes it to that project's GitLab Container
  Registry path (`$CI_REGISTRY_IMAGE`).
- Deployments pull that image by tag/digest — never `:latest` in a
  production Deployment manifest. Tag images with `$CI_COMMIT_SHORT_SHA` (or
  a semver tag on release) so rollbacks are just "redeploy the previous
  tag."
- Container Registry is enabled instance-wide at `registry.rmwhs.com`
  (see [manifest/gitlab-omni-ce.yaml](k8s-infrastructure/manifest/gitlab-omni-ce.yaml)).
  `$CI_REGISTRY_IMAGE` should now be populated in job environments.

### 2.4 Namespace per app
- Each app gets its own Kubernetes namespace, named after the app
  (`kubectl create namespace <app>`). Don't deploy multiple unrelated apps
  into `default` or into each other's namespaces.

### 2.5 Every container declares resource requests and limits
- No container may run without explicit `resources.requests` and
  `resources.limits` for both `cpu` and `memory`. All app workloads share
  the single 4-core/24GiB `elitedesk-800` node, so one unbounded pod can
  starve everything else, including GitLab itself. On `optiplex-tower`, one
  unbounded database can starve every other data store.
- Start conservative (e.g. `100m`/`128Mi` requests) and raise only if you
  observe throttling/OOM for that specific workload.

### 2.6 No privileged containers
- `privileged: true` / Docker-in-Docker is not permitted for image builds.
  Use **kaniko** or **buildah** to build images inside CI instead. If a
  workload genuinely needs elevated privileges, that's an exception to
  discuss explicitly, not a default.

### 2.7 Secrets are never committed to a repo or hardcoded in a manifest
- No credentials, tokens, or connection strings in `Dockerfile`,
  `.gitlab-ci.yml`, or any committed YAML — see [Section 5](#5-secrets-management)
  for where they actually go.

---

## 3. Best Practices

### 3.1 Be resource-efficient by default
- Prefer `replicas: 1` unless you have a concrete reason for more. Every
  stateless workload runs on the one general-compute node, so extra
  replicas don't buy you failover, only more resource pressure.
- Prefer small base images (`alpine`, `distroless`, slim variants) to keep
  image pulls and disk usage down on `local-path` storage.
- Set `readinessProbe`/`livenessProbe` on anything long-running so a stuck
  pod doesn't silently eat capacity while reporting nothing.

### 3.2 Keep `.gitlab-ci.yml` declarative — push logic into scripts
- Don't write long multi-line shell logic directly inline in `script:`
  blocks. Put it in a tracked, executable script and call that:

  ```
  myproject/
    ci/
      build.sh
      deploy.sh
    .gitlab-ci.yml
  ```

  ```yaml
  build:
    stage: build
    script:
      - ./ci/build.sh
  ```

  This keeps the pipeline readable, lets you lint/shellcheck the scripts,
  and lets you run the exact same script locally to reproduce a failing
  build instead of guessing from CI output.

### 3.3 Deployment secrets are configured in GitLab *before* the pipeline needs them
- Registry credentials, deploy tokens, kubeconfig/service-account tokens,
  third-party API keys — all set up as **GitLab CI/CD variables**
  (Project/Group → Settings → CI/CD → Variables) ahead of time, marked
  **Protected** and **Masked**. A pipeline should never be the first place
  a secret value is typed in.

### 3.4 Runtime environment variables: GitLab CI/CD variables vs. Kubernetes Secrets
Two different jobs — use the right one:

| Use **GitLab CI/CD variables** for... | Use **Kubernetes Secrets** (etcd) for... |
|---|---|
| Values only the *pipeline* needs (registry auth, deploy-token, kubeconfig) | Values the *running pod* needs at container start |
| Build-time secrets baked via `--build-arg` | DB passwords, API keys the app reads from env at runtime |
| Values that differ per pipeline run | Values that persist independent of any given CI run |

In practice: CI reads a GitLab CI/CD variable and uses it to **create or
update a Kubernetes Secret** in the target namespace as a deploy step (or
that Secret is pre-created once by hand and just referenced by the
Deployment via `envFrom`/`secretKeyRef` — see the `headlamp-oidc` Secret in
the `headlamp` namespace for a working example of this pattern). The app's
Deployment manifest never contains a literal secret value — only a
`secretKeyRef`.

### 3.5 CI deploy steps use a scoped Service Account, not cluster-admin
- Don't reuse the GitLab Runner's own service account/kubeconfig for
  `kubectl apply`/`helm upgrade` deploy steps — the runner's RBAC is scoped
  narrowly to spawning job pods in the `gitlab-runner` namespace and
  shouldn't be widened.
- Each app's namespace should have its own least-privilege
  ServiceAccount + Role/RoleBinding (create/update Deployments, Services,
  Ingresses, ConfigMaps, Secrets — scoped to that one namespace only). Mint
  a token for that ServiceAccount, store it as a masked/protected GitLab
  CI/CD variable, and have the deploy script do:
  ```bash
  kubectl config set-cluster k3s --server="$K8S_API_SERVER" --insecure-skip-tls-verify=true
  kubectl config set-credentials ci --token="$DEPLOY_SA_TOKEN"
  kubectl config set-context ci --cluster=k3s --user=ci --namespace="$APP_NAMESPACE"
  kubectl config use-context ci
  ```

### 3.6 Storage caveats
- `local-path` is `ReadWriteOnce` and `WaitForFirstConsumer` only. There
  are no shared/multi-pod volumes, and a PVC binds **permanently** to
  whichever node its first pod lands on. Now that there are two nodes,
  this matters: databases, caches, and object storage must carry the
  `dedicated: storage` nodeSelector + toleration from §1.1 on their first
  deploy, so they bind on `optiplex-tower`. Any other PVC-backed workload
  binds on whichever compute node it lands on first, so pin it with a
  required affinity.
- Don't request persistent storage for anything that can be stateless.
  Reach for a PVC only when the app genuinely needs to persist data across
  restarts.

---

## 4. Standard Project Layout

Every deployable app repo should look roughly like this:

```
myapp/
  Dockerfile
  .gitlab-ci.yml
  ci/
    build.sh
    deploy.sh
  k8s/
    namespace.yaml
    deployment.yaml
    service.yaml
    ingress.yaml
    (serviceaccount.yaml + role.yaml + rolebinding.yaml, if not pre-provisioned)
```

Plain manifests (not a Helm chart) are the default for application
workloads — reach for Helm only if the app genuinely needs
templating/parameterization across environments. Infrastructure components
(GitLab itself, the runner, Headlamp) use Helm; that doesn't mean your app
needs to.

---

## 5. Secrets Management

Two systems, two purposes — don't blur them:

1. **GitLab CI/CD Variables** — scoped to a project or group, used by the
   *pipeline*. Set them under Settings → CI/CD → Variables, mark
   Protected (only exposed on protected branches/tags) and Masked (hidden
   in job logs) by default.
2. **Kubernetes Secrets** — live in etcd, scoped to a namespace, used by
   the *running pod*. Create once with `kubectl create secret generic
   <name> -n <namespace> --from-literal=key=value`, then reference from the
   Deployment:
   ```yaml
   env:
     - name: DATABASE_PASSWORD
       valueFrom:
         secretKeyRef:
           name: myapp-secrets
           key: databasePassword
   ```

Rule of thumb: if a human or a CI job needs the value to talk to GitLab/the
cluster, it's a GitLab CI/CD variable. If the *application process* needs
the value once it's running, it's a Kubernetes Secret.

---

## 6. Standard Pipeline Shape

A typical `.gitlab-ci.yml` for an app on this cluster:

```yaml
stages:
  - build
  - deploy

build-image:
  stage: build
  image: gcr.io/kaniko-project/executor:debug
  script:
    - ./ci/build.sh
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

deploy:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - ./ci/deploy.sh
  environment:
    name: production
    url: https://myapp.rmwhs.com
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

`ci/build.sh` builds with kaniko (no Docker-in-Docker, no `privileged`)
using `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA` as the tag and pushes to the
registry. `ci/deploy.sh` sets up the scoped kubeconfig (§3.5) and runs
`kubectl apply -f k8s/` (substituting the new image tag first, e.g. via
`envsubst` or `kubectl set image`).

---

## 7. Reference: Current Cluster Inventory

| Namespace | What | Ingress host |
|---|---|---|
| `gitlab` | Self-hosted GitLab CE (raw manifest, not Helm) | `gitlab.rmwhs.com` |
| `gitlab-runner` | GitLab Runner, kubernetes executor | — (no ingress; polls outbound) |
| `headlamp` | Cluster dashboard (Helm) | `headlamp.rmwhs.com` |
| `ingress-nginx` | Standalone nginx ingress controller (`nginx-external`) | — |
| `monitoring` | kube-prometheus-stack (Prometheus, Alertmanager, Grafana) | `prometheus.rmwhs.com`, `alertmanager.rmwhs.com`, `grafana.rmwhs.com` |
| `openobserve` | log and trace backend | `openobserve.rmwhs.com` |
| `infisical` | secrets manager | `infisical.rmwhs.com` |
| `rabbitmq` | shared broker | — |
| `mailpit` | dev SMTP and mailbox UI | (cluster-local / optional ingress) |

Relevant files:
- [helm/gitlab-runner-values.helm.yaml](k8s-infrastructure/helm/gitlab-runner-values.helm.yaml)
- [helm/gitlab-ce-values.helm.yaml](k8s-infrastructure/helm/gitlab-ce-values.helm.yaml) (alternate Helm-based GitLab install — not the one currently deployed; the running instance uses [manifest/gitlab-omni-ce.yaml](k8s-infrastructure/manifest/gitlab-omni-ce.yaml))
- [helm/headlamp-values.helm.yaml](k8s-infrastructure/helm/headlamp-values.helm.yaml)
- [manifest/headlamp-ingress.yaml](k8s-infrastructure/manifest/headlamp-ingress.yaml)

---

## 8. Known Gaps / Open Items

- **Infisical Kubernetes Operator** installed 2026-11-23: chart `infisical-helm-charts/secrets-operator` 0.11.18, release `infisical-operator` in namespace `infisical-operator` (AegisPulse MB-05).

Be aware of these when onboarding a new app — they're cluster-level
prerequisites, not something to work around per-project:

- **Cloudflare Tunnel (free tier) caps request bodies at 100MB.** This is
  enforced at Cloudflare's edge and is not configurable without upgrading
  the zone's plan. Docker registry pushes upload one layer per request, so
  in practice this means: **no single image layer may exceed 100MB.**
  Multi-stage builds and slim base images keep this a non-issue for most
  apps; a single large `COPY` of a dataset/model/bundle is what would
  actually hit it. Same 100MB cap applies to large git pushes / Git LFS
  objects through `gitlab.rmwhs.com`. This is separate from (and in
  addition to) `client_max_body_size` on nginx/ingress-nginx, which is
  already set to unlimited on the `gitlab`/registry stack — Cloudflare's
  limit is the one that can't be tuned away.
- **No cert-manager** — TLS is entirely dependent on Cloudflare's proxy
  staying in front of every hostname. If a subdomain's DNS record is ever
  set to "DNS only" (grey-clouded) in Cloudflare, it will serve unencrypted
  HTTP directly.
- **No shared/RWX storage** — anything needing multi-pod shared storage
  isn't currently supported.
- **No HA** — the three nodes have separate roles, and none is a standby
  for another. If `elitedesk-800` reboots or fails, the control plane,
  GitLab, the registry, ingress, and every app go down. If
  `optiplex-tower` reboots or fails, every app database, cache, and object
  store pinned there goes down. Their `local-path` PVs can't be
  rescheduled elsewhere. If `optiplex` fails, app pods reschedule onto
  `elitedesk-800` if capacity allows; pods pinned to it by a PVC or a
  required affinity do not.
- **k3s version skew.** The agents (`optiplex`, `optiplex-tower`) run
  v1.37 against a v1.36 server. Kubernetes doesn't support a kubelet newer
  than the API server. Upgrade the server (`elitedesk-800`) to the agents'
  minor version before relying on new features, and always upgrade the
  server first from now on.
- **API server certificate lacks the Tailscale address** — remote
  `kubectl` needs `--tls-server-name` until `tls-san` is added (§4).
- **Shared stateful services still live on `elitedesk-800`** (GitLab data,
  Infisical PostgreSQL/Redis, RabbitMQ, OpenObserve, Prometheus). They
  are candidates to move onto `optiplex-tower`'s SSD later, each one by
  backup → delete PVC → redeploy with the storage stanza → restore. This
  is optional and not done yet.

---

## 9. DevSecOps Security Baseline (Lightweight)

For this cluster size, prioritize GitLab-native security analyzers and add
only lightweight in-cluster runtime scanning.

### 9.1 CI security gates (GitLab-native)

- Reuse GitLab templates for SAST, Secret Detection, Dependency Scanning,
  Container Scanning, and IaC SAST.
- Scaffold reusable config with:
  - `~/bash-scripts/scaffold-gitlab-devsecops-ci.sh`
- Output template path:
  - `~/kubernetes/k8s-infrastructure/gitlab-templates/devsecops-security.gitlab-ci.yml`

### 9.2 Runtime scanning (in-cluster)

- Install Trivy Operator with conservative resource limits:
  - `~/bash-scripts/install-trivy-operator.sh`
- Report queries:
  - `kubectl get vulnerabilityreports -A`
  - `kubectl get configauditreports -A`

This approach avoids introducing heavyweight extra platforms when GitLab
already covers most SDLC security controls.

---

## 10. Checklist for Onboarding a New App

- [ ] Repo has `Dockerfile`, `.gitlab-ci.yml`, `k8s/`, `ci/*.sh`
- [ ] Image build uses kaniko/buildah, pushes to `$CI_REGISTRY_IMAGE`,
      tagged with `$CI_COMMIT_SHORT_SHA` (not `:latest`)
- [ ] Dedicated namespace created for the app
- [ ] Dedicated least-privilege ServiceAccount + Role for CI deploys (not
      the runner's own SA, not cluster-admin)
- [ ] `resources.requests` and `resources.limits` set on every container
- [ ] `readinessProbe`/`livenessProbe` configured
- [ ] Databases/caches/object storage carry the `dedicated: storage`
      nodeSelector + `dedicated=storage:NoSchedule` toleration (§1.1)
      **before first deploy**; stateless workloads carry neither and
      prefer `node-role.kubernetes.io/worker=true`
- [ ] Ingress uses `ingressClassName: nginx-external`, a unique
      `<app>.rmwhs.com` subdomain, and `ssl-redirect: "false"`
- [ ] No apex-domain binding, no `privileged: true`, no secrets committed
      to the repo
- [ ] Runtime secrets live in a Kubernetes Secret in the app's namespace;
      pipeline secrets live in GitLab CI/CD variables (Protected + Masked)
