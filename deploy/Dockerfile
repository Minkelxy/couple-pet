FROM node:24-alpine
WORKDIR /app
COPY apps/server ./apps/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 PET_DATA_FILE=/data/shared-pet.json PET_BACKUP_DIR=/data/backups
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4317/health || exit 1
USER node
CMD ["node", "apps/server/index.js"]
