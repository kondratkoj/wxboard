# wxboard container. No npm packages are needed; this is just Node plus the source.
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WX_DATA_DIR=/data \
    WX_CONFIG=/config/config.json

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data /config && chown node:node /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
