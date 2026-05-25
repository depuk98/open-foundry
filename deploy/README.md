# Open Foundry — Development Deployment

Local development environment with all 13 services via Docker Compose.

## Prerequisites

- Docker Engine 24+ with Compose v2
- `curl` (for init script — OpenFGA setup)

## Quick Start

```bash
# 1. Copy environment config and set passwords
cp .env.example .env
# Edit .env — at minimum, change POSTGRES_PASSWORD and KEYCLOAK_ADMIN_PASSWORD

# 2. Start all services (--build ensures images reflect latest source)
docker compose up -d --build

# 3. Wait for infrastructure, then initialize
./init-services.sh

# 4. Open GraphQL Playground
open http://localhost:4000/graphql
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| api-gateway | 4000 | GraphQL + REST + FHIR |
| ontology-engine | 4001 (internal) | Object lifecycle, validation |
| action-executor | 4002 (internal) | CEL-based action pipeline |
| sync-engine | 4003 (internal) | Overlay mode, CDC |
| security-service | 4004 (internal) | OIDC, OpenFGA authz, audit |
| cel-evaluator | 50051 | gRPC CEL runtime |
| openfga | 8280 | Authorization (ReBAC) |
| postgresql | 5432 | PostgreSQL 17 + Apache AGE |
| redis | 6379 | Rate limiter + cache store |
| redpanda | 19092 | Kafka-compatible streaming |
| debezium | 8083 | Change Data Capture |
| otel-collector | 4317 | OpenTelemetry traces/metrics |
| keycloak | 8180 | Identity provider (OIDC) |

## Init Script

`init-services.sh` performs:

1. Waits for PostgreSQL readiness
2. Creates the Apache AGE extension and graph
3. Waits for OpenFGA readiness
4. Creates an OpenFGA store and loads the NHS authorization model
5. Creates domain pack registry tables (packs are registered by api-gateway at boot)

## Development Mode vs Production Mode

**The shipped `docker-compose.yaml` runs every app service with
`NODE_ENV=development`.** Dev mode exists for fast local iteration and
**disables all governance enforcement**. In dev mode the api-gateway
(`packages/api/src/server.ts`, where `isDev = NODE_ENV !== 'production'`):

- **OpenFGA → allow-all stub** — every `check` returns `true`, `listObjects`
  returns the `['*']` "all authorized" sentinel.
- **CEL evaluator → allow-all stub** — every action precondition evaluates `true`.
- **Security layer → allow-all** — and when no `Authorization` header is present,
  `extractUser` returns a **synthetic admin user** with every role.

**Consequence:** a default `docker compose up` demonstrates none of the
ReBAC / CEL / consent enforcement the platform is built for. To evaluate or
integrate against real governance, you **must** set `NODE_ENV=production` on the
app services (and satisfy the production requirements below).

### Boot ordering: create the OpenFGA store *before* api-gateway

In production the FGA client is only wired when `OPENFGA_STORE_ID` is non-empty
**at boot**. `init-services.sh` creates the store and writes that ID, but a plain
`docker compose up -d` starts api-gateway *before* the init script runs — so the
gateway boots without a store ID and silently falls back to the allow-all FGA stub
even in production mode.

**Correct production order:**

```bash
# 1. Start dependencies only (not api-gateway)
docker compose up -d postgresql openfga keycloak redis redpanda

# 2. Create the OpenFGA store + write OPENFGA_STORE_ID, provision AGE
./init-services.sh

# 3. Start api-gateway last, now that the store ID is available
docker compose up -d api-gateway
```

### Schema-checksum drift on re-deploy with persisted volumes

Re-deploying after a domain-pack DDL change against an **existing** PostgreSQL
volume fails hard at boot:

```
Schema migration: version 1 already applied but DDL checksum differs.
Expected <a>, got <b>.
```

This is a safety check in `storage-postgres` `applySchema` — it refuses to
silently diverge from the persisted schema. Recovery options:

- **Bump the schema version** in your domain pack (preferred for real migrations).
- **Wipe the volume** for throwaway/dev data: `docker compose down -v`.

## Identity Provider (OIDC) Integration

Production auth requires OIDC access tokens that satisfy
`OidcAuthenticator` (`packages/security/src/auth/oidc-authenticator.ts`). Two
requirements are easy to miss — each fails with an opaque `401 UNAUTHENTICATED`:

1. **`aud` must equal the configured client id.** The authenticator sets
   `audience = clientId` (`OIDC_CLIENT_ID`) and validates it. Keycloak access
   tokens default to `aud: "account"` and will be **rejected**. Add an
   **audience protocol mapper** that includes your client in the `aud` claim.
2. **A `tenant_id` claim is mandatory.** `extractUser` throws `MISSING_TENANT`
   when the tenant claim is absent — and no default tenant is configured. Add a
   mapper (hardcoded claim or per-user attribute) that emits `tenant_id`.

Required token claims:

| Claim | Requirement |
|-------|-------------|
| `sub` | Subject — used as the actor/user id |
| `aud` | Must equal `OIDC_CLIENT_ID` |
| `tenant_id` | Mandatory — request is rejected without it |
| `roles` | **Flat top-level array** — the authenticator reads `claims["roles"]` directly (`role-mapping.ts` `resolveRoles`, `DEFAULT_ROLE_MAPPING.claimName = "roles"`). It does **not** descend into Keycloak's nested `realm_access.roles`. Add a Keycloak realm-role mapper (`oidc-usermodel-realm-role-mapper`, `claim.name=roles`, multivalued) — otherwise the actor has no roles and CEL preconditions like `actor.hasRole('clinician')` fail with `PRECONDITION_FAILED` even after OpenFGA passes. |

### Issuer vs JWKS host split

A token minted from the host (`iss=http://localhost:8180/...`) cannot be verified
by the in-container gateway unless JWKS is fetched **in-network**
(`http://keycloak:8080/...`). The gateway supports this via two separate env vars
— set both when the external issuer URL differs from the in-cluster address:

```bash
OIDC_ISSUER=http://localhost:8180/realms/openfoundry      # must match token `iss`
OIDC_JWKS_URI=http://keycloak:8080/realms/openfoundry/protocol/openid-connect/certs
```

### Keycloak realm is not auto-provisioned

Keycloak runs `start-dev` with **no realm import** — only the `master` realm
exists at boot. The `KEYCLOAK_REALM=openfoundry` env names a realm that nothing
creates, and `init-services.sh` does **not** provision Keycloak (only OpenFGA +
AGE). Before production auth works you must create the realm, client (with the
audience + `tenant_id` mappers above), users, and roles yourself — via a realm
import JSON or a provisioning script.

## Authorization Tuples for Actions

Action authorization (`packages/api/src/config.ts`, `createSecurityLayer`) checks
`can_<verb>` **directly on the target object** (e.g. `user:<sub>` →
`can_discharge` → `patient:<id>`). It does **not** derive contextual tuples from
roles. Per the NHS model, relations like `patient.can_discharge` resolve from
direct `[user]` relations on the patient object (`clinician`, `nurse_in_charge`).

**Footgun:** a freshly created object has no care-team tuples, so `can_admit` /
`can_discharge` / `can_transfer` are checked *before any tuple exists* → the
action is **denied for everyone**, including clinicians. (`writeRelationship`
exists on `AuthorizationService` but is **not** called anywhere in the
object-lifecycle or action pipeline, and there is no REST/GraphQL tuple-write
surface.) Ward `assigned` tuples grant only `viewer`/`editor` visibility — **not**
the action verbs.

**Until a tuple-write API exists, integrators must provision relationship tuples
out-of-band** by writing directly to OpenFGA. For example, grant the acting
clinician on admission:

```
(user:<sub>, clinician, patient:<id>)
```

## Driving an Action via REST (with auth)

Actions are exposed at `POST /api/v1/actions/{ActionType}`. End-to-end against a
production stack:

```bash
# 1. Get a token (client-credentials or password grant; must carry aud + tenant_id)
TOKEN=$(curl -s -X POST \
  "http://localhost:8180/realms/openfoundry/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=openfoundry \
  -d username=<user> -d password=<pass> | jq -r .access_token)

# 2. Call the action (body keys are the action's @param fields)
curl -X POST http://localhost:4000/api/v1/actions/AdmitPatient \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patient":"<patient-id>","ward":"<ward-id>"}'

# 3. A 200 returns { success, data, warnings? }; a 403 usually means the
#    required can_<verb> tuple is missing (see "Authorization Tuples" above).
```

## Action Pipeline Footguns (end-to-end)

Surfaced driving a real `AdmitPatient` to success (authorize → consent → CEL →
effects → audit). These bite a production single-trust pilot specifically.

- **Two independent authz layers must both pass.** (1) OpenFGA `can_<verb>` at the
  authorize stage (needs the per-object care-team tuple above) → fails as
  `AUTHORIZATION_DENIED`. (2) CEL `actor.hasRole(...)` in the manifest
  preconditions (needs the flat `roles` claim, see OIDC table) → fails as
  `PRECONDITION_FAILED`. A clinician can satisfy (1) via a written tuple and still
  fail (2) for a missing roles claim — two separate root causes for the same
  "clinician can't act" symptom.

- **Consent blocks admission of a not-yet-admitted patient.** With
  `directCareExemptionEnabled: true` (gateway default), the DIRECT_CARE exemption
  (`consent-service.ts` `evaluateDirectCareExemption`) checks a care relation that
  defaults to `viewer` (`careRelation ?? "viewer"`). But `patient.viewer = viewer
  from admitted_to` — it derives from ward admission, so a freshly seeded/synced
  (un-admitted) patient has no `viewer`, the exemption returns null, and
  `AdmitPatient` fails `CONSENT_DENIED`. There is **no REST/GraphQL surface to
  record consent** (only in-process `ConsentService.recordConsent`); integrators
  must insert a `GRANT` row directly into `consent.consent_records` (the decision
  enum value is `"GRANT"`, not `"ALLOW"`). *Fix direction: make `careRelation`
  configurable (e.g. `clinician`) and expose a consent-record API.*

- **Read visibility after admission needs an `admitted_to` tuple nothing writes.**
  `AdmitPatient` creates the ontology `AdmittedTo` link, but the admitting
  clinician then gets `403` reading that patient: object reads use `patient.viewer
  = viewer from admitted_to`, which requires an OpenFGA `(patient:<id>,
  admitted_to, ward:<id>)` tuple. Action effects create the ontology link but **do
  not** write the corresponding FGA tuple (read-side counterpart of the write-side
  tuple gap above). ED (un-admitted) patients have no ward → no ward-scoped viewer
  can see them. *Fix direction: write graph-derived ReBAC tuples as part of link
  effects, or provide an operational read role.*
  - **Same gap for every `... from <link>` rule.** Any FGA rule that traverses a
    link userset needs the corresponding relationship tuple to exist. E.g.
    `bed.can_clean = editor or porter from in_ward` (the `CleanBed` action) only
    resolves when a `(bed:<id>, in_ward, ward:<id>)` tuple exists, but the pipeline
    writes the `BedInWard` *ontology link*, not the OpenFGA tuple. Integrators must
    provision these tuples out-of-band (derive bed→ward from the store and write
    them). If link effects emitted relationship tuples for `BedInWard`,
    `AdmittedTo`, ward `assigned`, etc., these `from <link>` rules would work out
    of the box.

- **Denied actions are not audited.** The pipeline order is validate → authorise →
  consent → preconditions → execute → side-effects → **audit** → emit. A denial at
  authorize/consent/precondition returns *before* the audit step, so
  `audit.audit_records` captures successes but not refused attempts — the opposite
  of what IG/security review wants. *Fix direction: emit an audit record (actor,
  target, decision, reason, traceId) on every pre-execute denial.*

- **Boot-seed data lands under tenant `system`.** `server.ts` seeds with
  `bootCtx = { tenantId: 'system' }`. Object rows are tenant-scoped (`_tenant_id`)
  and `getObject` filters `WHERE _tenant_id = $1`, so pack `seed:` data is
  invisible to requests on any other tenant (symptom: the object resolves far
  enough to enter the pipeline, then fails a field-dependent CEL precondition with
  `no such key: <field>`). *Fix direction: make the seed tenant configurable or
  seed per-tenant; until then, clients must use the `system` tenant to read seeded
  reference data.*

## External Domain Packs

To load domain packs from outside the monorepo:

1. Set `DOMAIN_PACKS_HOST_DIR` in `.env` to the host path of your pack (or a parent directory containing multiple packs):
   ```bash
   DOMAIN_PACKS_HOST_DIR=../../silmaril-dp-rce
   DOMAIN_PACKS_EXTRA_DIRS=/external-packs
   ```

2. Add the pack name to `DOMAIN_PACKS` if you use an explicit pack list:
   ```bash
   DOMAIN_PACKS=core,nhs-acute,rce
   ```

3. Restart the api-gateway: `docker compose up -d --build api-gateway`

The host path is mounted read-only at `/external-packs` inside the container. The schema loader scans it for `pack.yaml` files using the same discovery logic as the primary `domain-packs/` directory.

For full details (pack.yaml format, Helm config, permissions, connectors, troubleshooting), see [docs/external-domain-packs.md](../docs/external-domain-packs.md).

## Rebuilding After Updates

After pulling source changes, always pass `--build` to pick up code changes:

```bash
docker compose up -d --build
```

To stamp the git revision into image labels (visible via `docker inspect`):

```bash
GIT_REVISION=$(git rev-parse HEAD) docker compose up -d --build
```

Without `--build`, Docker Compose reuses locally cached images and will not
reflect source changes. This applies to both TypeScript services and the Go
CEL evaluator.

**Domain-pack changes need an api-gateway rebuild too.** New or changed actions
(ODL `@actionType` + manifest), permissions, or seeds are baked into the
api-gateway image. A stale image will **404 a newly added action** (e.g. a
`POST /api/v1/actions/CleanBed` against an image built before the action existed).
After changing a pack, rebuild: `docker compose up -d --build api-gateway`.

## Teardown

```bash
docker compose down        # Stop services (keep data)
docker compose down -v     # Stop and remove volumes
```
