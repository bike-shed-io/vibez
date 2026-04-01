# Build stage
FROM docker.io/oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Production stage
FROM docker.io/oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY public/ public/
COPY tsconfig.json .

USER bun
EXPOSE 3005
CMD ["bun", "run", "src/index.ts"]
