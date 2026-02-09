# Sync Engine — overlay mode, CDC, and connector management
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json ./
COPY packages/ packages/
COPY domain-packs/ domain-packs/

RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@openfoundry/sync...

FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/domain-packs/ domain-packs/

RUN pnpm install --frozen-lockfile --prod

EXPOSE 4003

CMD ["node", "packages/sync/dist/index.js"]
