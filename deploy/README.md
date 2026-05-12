# Open Foundry — Development Deployment

Local development environment with all 13 services via Docker Compose.

## Prerequisites

- Docker Engine 24+ with Compose v2
- `psql` CLI (for init script)
- `curl` (for init script)

## Quick Start

```bash
# 1. Copy environment config and set passwords
cp .env.example .env
# Edit .env — at minimum, change POSTGRES_PASSWORD and KEYCLOAK_ADMIN_PASSWORD

# 2. Start all services
docker compose up -d

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

3. Restart the api-gateway: `docker compose up -d api-gateway`

The host path is mounted read-only at `/external-packs` inside the container. The schema loader scans it for `pack.yaml` files using the same discovery logic as the primary `domain-packs/` directory.

For full details (pack.yaml format, Helm config, permissions, connectors, troubleshooting), see [docs/external-domain-packs.md](../docs/external-domain-packs.md).

## Teardown

```bash
docker compose down        # Stop services (keep data)
docker compose down -v     # Stop and remove volumes
```
