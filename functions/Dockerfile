# TransCircle Backend — Express + MySQL
# Build stage: CI compiles TypeScript externally (pnpm run build),
# this image only packages the compiled output and production deps.

FROM node:22-alpine AS runner

WORKDIR /app

# Copy production dependency manifests
COPY package.json pnpm-lock.yaml ./

# Install pnpm and production dependencies only
RUN corepack enable && \
    pnpm install --prod --frozen-lockfile

# Copy pre-built output from CI
COPY dist/ ./dist/
COPY config.toml.example ./config.toml.example

# Create runtime directories
RUN mkdir -p logs image

EXPOSE 1145

ENV NODE_ENV=production

CMD ["node", "dist/Index.js"]
