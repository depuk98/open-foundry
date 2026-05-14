# Ontology Engine — object lifecycle, validation, events
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json tsconfig.build.json ./
COPY packages/ packages/
COPY domain-packs/ domain-packs/
COPY tests/ tests/
COPY tools/ tools/

RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@openfoundry/engine...

FROM node:20-alpine

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/domain-packs/ domain-packs/
COPY --from=builder /app/tests/ tests/
COPY --from=builder /app/tools/ tools/

RUN pnpm install --frozen-lockfile --prod

USER node

EXPOSE 4001

CMD ["node", "packages/engine/dist/server.js"]
