FROM node:24.21.0-bookworm-slim
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY libs ./libs
RUN npm ci && npm run build
CMD ["node", "dist/apps/media-edge/main.js"]
