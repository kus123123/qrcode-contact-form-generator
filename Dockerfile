FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "start"]
