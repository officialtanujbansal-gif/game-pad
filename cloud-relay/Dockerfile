FROM node:22-alpine
WORKDIR /app
COPY cloud-relay/package.json ./cloud-relay/package.json
RUN cd cloud-relay && npm install --omit=dev --no-audit --no-fund
COPY cloud-relay/server.mjs ./cloud-relay/server.mjs
COPY phone-remote ./phone-remote
ENV NODE_ENV=production
ENV OR_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "cloud-relay/server.mjs"]