# Hosted webhook server. Build compiles src/ to dist/; the runtime image keeps
# only production deps, dist, and migrations (the migration runner resolves
# `<app-root>/migrations` relative to the compiled file).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# `gh` serves the SCM reader (and the default shadow-status writer). Authenticate
# it by injecting GH_TOKEN at runtime — never bake a token into the image.
RUN apk add --no-cache github-cli
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY migrations ./migrations
EXPOSE 8080
USER node
CMD ["node", "dist/server/main.js"]
