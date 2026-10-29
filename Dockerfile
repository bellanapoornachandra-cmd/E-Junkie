# Use official Node.js 24 Alpine image for minimal size and high performance
FROM node:24-alpine

WORKDIR /app

# Ensure data directory exists for SQLite database storage
RUN mkdir -p /data

# Copy package definition and install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application files
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV EJ_DB=/data/ejunkie.db

EXPOSE 3000

# Health check to ensure server is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "server/server.js"]

