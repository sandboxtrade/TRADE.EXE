FROM node:20-slim

WORKDIR /app

# Копируем движок как обычную зависимость файловой системы (npm workspaces
# работали бы так же — это упрощённый вариант без монорепо-тулинга).
COPY packages/engine /app/packages/engine
COPY server/package.json server/package-lock.json* /app/server/
WORKDIR /app/server
RUN npm install --omit=dev

COPY server /app/server

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
