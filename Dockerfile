FROM node:24-alpine

WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

COPY server/src server/src
COPY web web

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CONFIG_FILE=/app/config/pchat.json
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
