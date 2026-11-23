FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY scripts/build_cloud_app.mjs ./scripts/build_cloud_app.mjs
RUN npm run build:web

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --chown=node:node frontend-web/server.mjs ./frontend-web/server.mjs
COPY --from=build --chown=node:node /build/build/cloud-web ./public
USER node
EXPOSE 8080
CMD ["node", "frontend-web/server.mjs"]
