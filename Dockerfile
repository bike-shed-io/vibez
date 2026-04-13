FROM docker.io/oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src/ src/
COPY public/ public/
COPY tsconfig.json .

USER bun
EXPOSE 3005
CMD ["bun", "run", "src/index.ts"]
