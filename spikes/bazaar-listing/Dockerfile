# Спайк-витрина: официальный x402-стек требует зависимостей, поэтому
# read-only bind-mount из Phase 0 заменён на собранный образ.
# settle.mjs (покупатель, приватный ключ) в образ НЕ кладём — серверу он не нужен.
FROM node:22-alpine

# su-exec нужен entrypoint'у: правку /etc/hosts делаем root'ом, сервер запускаем от node
RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY catalog.json server.mjs probe.mjs ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 4021
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
