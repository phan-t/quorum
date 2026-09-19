# Quorum — the service image.
#
# The server runs its TypeScript directly (Node strips the types and executes
# the result), so it needs no compile step. The three browser clients do: a
# browser cannot run .ts, so tsc emits them to dist/client and the server serves
# that directory. An image without it starts, answers /healthz, and returns 404
# for every page — which is exactly how this was found.
#
# Types are stripped, not checked. `npm run typecheck` in CI is the only thing
# that reads them, which is why the PR workflow blocks on it.

# ---- deps -------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /srv/quorum

# Only the manifests, so this layer is cached until a dependency actually
# changes — the source changes on every commit and must not invalidate it.
COPY package.json package-lock.json ./

# --ignore-scripts: nothing in this tree needs a postinstall, and a build script
# in a transitive dependency is arbitrary code running as root at image build.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- client -----------------------------------------------------------------
# The browser code, compiled. Separate from `deps` because it needs the dev
# dependencies (tsc) that the runtime image must never contain.
FROM node:24-alpine AS client

WORKDIR /srv/quorum

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build:client

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

# QUORUM_ENV and QUORUM_TABLE are set by the ECS task definition, because
# Terraform is what knows their values. QUORUM_ADMIN_KEY arrives from SSM via
# the task definition's `secrets` and is deliberately absent here.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /srv/quorum

# `node` (uid 1000) ships with the official image. Own the tree at copy time
# rather than with a `chown -R` layer, which would duplicate every file.
COPY --from=deps --chown=node:node /srv/quorum/node_modules ./node_modules
# package.json, for its `"type": "module"` — without it Node treats every .ts
# file as CommonJS and the ESM imports fail at startup. Nothing else in it is
# read at runtime.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
# The compiled clients. main.ts resolves QUORUM_CLIENT_ROOT to ../../dist/client
# relative to itself, so this path is not arbitrary.
COPY --from=client --chown=node:node /srv/quorum/dist ./dist

USER node

EXPOSE 3000

# The same endpoint the ALB target group and the deploy-freeze check use. Node's
# own fetch rather than curl or wget: no extra package in the image, and no
# dependency on which busybox applets this base happens to carry.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No npm in the entrypoint: npm would be PID 1 and would not forward SIGTERM,
# and SIGTERM is how the process learns to write final snapshots and close
# sockets with 1012 before ECS kills it 30 seconds later.
#
# No --experimental-strip-types either: Node 24 strips types by default. The
# flag still exists for Node 22 and package.json passes it there; here it would
# only be noise.
CMD ["node", "src/server/main.ts"]
