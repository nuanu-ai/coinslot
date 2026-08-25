#!/bin/sh
# Сеть VM отдаёт подменённую A-запись для api.cdp.coinbase.com: провайдерская
# блокировка Coinbase резолвит имя в чужой IP, и TLS падает с
# «tlsv1 unrecognized name». IP-уровень при этом НЕ заблокирован — настоящий
# адрес Cloudflare отвечает нормально. Поэтому резолвим имена фасилитатора
# через DoH (мимо перехваченного UDP:53) и пишем результат в /etc/hosts.
#
# Список хостов настраивается: DOH_HOSTS="a.example b.example".
set -e

for HOST in ${DOH_HOSTS:-api.cdp.coinbase.com}; do
  IP=$(node -e '
const host = process.argv[1];
fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
  headers: { accept: "application/dns-json" },
})
  .then((r) => r.json())
  .then((j) => {
    const a = (j.Answer || []).filter((x) => x.type === 1);
    if (a.length) console.log(a[0].data);
  })
  .catch(() => {});
' "$HOST" 2>/dev/null || true)
  if [ -n "$IP" ]; then
    echo "$IP $HOST" >> /etc/hosts
    echo "[entrypoint] $HOST -> $IP (DoH, в обход перехваченного DNS)"
  else
    echo "[entrypoint] DoH для $HOST не сработал, остаёмся на системном резолвере"
  fi
done

exec su-exec node "$@"
