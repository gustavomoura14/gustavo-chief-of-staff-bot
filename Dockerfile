# Container image for running the bot on Google Cloud Run (or any container
# host). The Render deployment does NOT use this file - it keeps running
# `npm start` from the repo as before.
#
# node:18-slim matches the package.json engines contract (>=18; global fetch
# is the only >=18 feature the code uses). Bumping to node:20/22-slim is a
# safe follow-up once Render's Node version is aligned.
FROM node:18-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production deps first so Docker layer caching skips npm ci when
# only source files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Run as the unprivileged `node` user built into the official Node images.
USER node

# Cloud Run injects PORT (default 8080); src/server.js reads process.env.PORT
# and falls back to 3000 for local runs. EXPOSE is documentation only.
EXPOSE 8080

CMD ["node", "src/server.js"]
