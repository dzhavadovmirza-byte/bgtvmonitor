# priceapi — small Node service that fronts the FIX gateway with the schema
# expected by the bgtvmonitor frontend. Single-stage; no native deps.
FROM node:20-alpine

WORKDIR /app

# Only package.json — no deps in this service (stdlib http + fetch).
COPY package.json ./

# Source.
COPY index.js ./
COPY prices.js ./

# Persist state (day aggregates, history) across restarts.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
ENV PORT=8081
ENV DATA_DIR=/data

EXPOSE 8081

# Liveness — plain TCP check is fine, /health is also exposed by index.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
