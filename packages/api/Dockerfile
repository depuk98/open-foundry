# API Gateway — GraphQL + REST + FHIR
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json ./

# Copy all packages (turbo needs the full workspace for dependency resolution)
COPY packages/ packages/
COPY domain-packs/ domain-packs/

RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@openfoundry/api...

# Runtime stage
FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/domain-packs/ domain-packs/

RUN pnpm install --frozen-lockfile --prod

EXPOSE 4000

CMD ["node", "packages/api/dist/index.js"]
