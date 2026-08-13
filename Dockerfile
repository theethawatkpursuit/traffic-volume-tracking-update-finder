# Persistent-process deployment (Render, Railway, Fly.io, any container host).
# This is the target the app is actually designed for: one long-lived process
# with a writable volume, so the dataset and geocode caches survive restarts
# and the background geocode warmup has somewhere to put its results.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Mount a persistent volume here in production (e.g. Render disk, Fly volume).
# Without one the app still runs, it just re-fetches the datasets on restart.
ENV DATA_DIR=/data
VOLUME ["/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
