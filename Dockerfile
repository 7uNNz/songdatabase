FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.html vite.config.ts postcss.config.mjs ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY server/package.json ./server/package.json
RUN npm install --omit=dev --prefix ./server
COPY server ./server
COPY --from=frontend-build /app/dist ./dist
COPY data/songs.json ./data/songs.json
ENV HOST=0.0.0.0 PORT=3000 REQUIRE_DATABASE_URL=1
EXPOSE 3000
CMD ["node", "server/index.mjs"]
