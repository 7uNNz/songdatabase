FROM node:24-alpine
WORKDIR /app
COPY server ./server
COPY dist ./dist
COPY data/songs.json ./data/songs.json
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/songs.sqlite
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server/index.mjs"]
