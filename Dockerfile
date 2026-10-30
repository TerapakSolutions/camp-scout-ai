FROM node:20-alpine AS build

WORKDIR /app

# Toolchain for compiling better-sqlite3 (native) on Alpine/musl.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# GA4 Measurement ID (G-XXXXXXX). Vite bakes VITE_* vars at build time, so it must
# be present here, not at runtime. Public by design (ships in the page), so it is a
# build arg, not a secret. Unset -> analytics no-ops. Set via fly.toml [build.args].
ARG VITE_GA_MEASUREMENT_ID=""
ENV VITE_GA_MEASUREMENT_ID=$VITE_GA_MEASUREMENT_ID

ENV CAMP_SCOUT_BASE=/
ENV BUILD_OUT_DIR=dist
RUN npm run build:fly

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
# Compile better-sqlite3 with a virtual toolchain, then drop it so the runtime
# image stays lean (the compiled .node binary is all that's needed at runtime).
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/data ./src/data
COPY --from=build /app/src/ingestion ./src/ingestion

# The commit, on the image. `flyctl deploy` exiting 0 means the deploy was ACCEPTED, not that the
# machine is running the new code. CI passes `--build-arg GIT_SHA=<sha>` and then reads
# `image_ref.labels.GH_SHA` back from every machine (same convention as seoplatform-admin).
# Must stay in THIS (final) stage: a label on the build stage never reaches the running image.
ARG GIT_SHA=unknown
LABEL GH_SHA=$GIT_SHA

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["npx", "tsx", "server/production.mjs"]
