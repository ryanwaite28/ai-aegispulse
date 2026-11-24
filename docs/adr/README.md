# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-polyglot-service-boundaries.md) | Polyglot service boundaries | Accepted |
| [0002](0002-gateway-service-separation.md) | Single gateway and no datastore access outside owning services | Accepted |
| [0003](0003-rabbitmq-topology-retry-dlq.md) | RabbitMQ topology, retry tiers, and dead-letter registry | Accepted |
| [0004](0004-transactional-outbox.md) | Transactional outbox | Accepted |
| [0005](0005-flyway-schema-per-service.md) | Flyway SQL migrations, schema-per-service | Accepted |
| [0006](0006-kustomize-homelab-k3s.md) | Homelab k3s with Kustomize; AWS as reference | Accepted |
| [0007](0007-supply-chain-gitlab.md) | Supply chain and DevSecOps gates | Accepted |
| [0008](0008-severity-lineage-elevate-only.md) | Severity lineage, elevate-only | Accepted |
| [0009](0009-files-outside-broker.md) | Files out of the broker | Accepted |
| [0010](0010-identity-jwt-zero-trust.md) | Registry JWTs verified everywhere | Accepted |
| [0011](0011-object-store-selection.md) | S3-compatible object store selection (SeaweedFS) | Accepted |
| [0012](0012-secrets-infisical.md) | Infisical runtime secrets | Accepted |
| [0013](0013-gateway-nestjs-fastify.md) | Gateway framework: NestJS on the Fastify adapter | Accepted |
| [0014](0014-dev-prod-environments.md) | Dev and prod environments on one cluster, separated by domain | Accepted |
| [0015](0015-node-roles-storage-on-optiplex-tower.md) | Node roles: data stores on `optiplex-tower`, app compute on `optiplex` | Accepted |
| [0016](0016-enforced-rls-bypass-definer-functions.md) | Enforced RLS bypass: cross-tenant work only through SECURITY DEFINER functions | Accepted |
| [0017](0017-service-account-secret-reconciliation.md) | Registry reconciles SERVICE account secret verifiers at startup | Accepted |

New ADRs: copy `0000-template.md`, take the next number, and amend `PROJECT.md` in the same MR (`/new-adr`).
