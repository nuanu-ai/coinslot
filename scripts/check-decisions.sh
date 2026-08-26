#!/usr/bin/env bash
#
# Проверка журнала решений: имена файлов и уникальность номеров.
#
# Зачем этот файл существует. Решения в docs/decisions ссылаются друг на друга
# и на research по номеру — «ADR-0003, п. 8» встречается и в коде, и в
# документах портала. Номер, выданный дважды, превращает эти ссылки в загадку,
# а имя не по образцу ломает сортировку каталога, по которой журнал читают.
# Обе беды дешевле поймать в CI, чем в разговоре через месяц; хук на такое не
# годится, потому что решение может приехать и не через локальный коммит.
#
# Чего скрипт сознательно не проверяет: неизменность уже принятых решений. По
# хартии решения остаются живыми документами — правка вносится прямо в файл, а
# история живёт в git. Возврат к append-only назван отдельным триггером, и это
# решение Дмитрия, а не умолчание скрипта.
#
# Почему bash: проверка читает имена файлов в одном каталоге. Инструмент,
# который для этого пришлось бы поставить, стоил бы дороже проверки.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
decisions_directory="${repository_root}/docs/decisions"

problems=0

report() {
  printf '%s\n' "$1" >&2
  problems=$((problems + 1))
}

if [ ! -d "${decisions_directory}" ]; then
  printf 'Каталога docs/decisions не существует — проверять нечего.\n' >&2
  exit 1
fi

numbers=""
found=0

for path in "${decisions_directory}"/*; do
  [ -e "${path}" ] || continue

  name="$(basename "${path}")"

  # README описывает формат журнала и сам решением не является.
  if [ "${name}" = "README.md" ]; then
    continue
  fi

  if [ ! -f "${path}" ]; then
    report "docs/decisions/${name}: решение — это файл, а не каталог."
    continue
  fi

  if ! printf '%s' "${name}" | grep -Eq '^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$'; then
    report "docs/decisions/${name}: имя не в формате NNNN-slug.md (четыре цифры, дефис, латиница в нижнем регистре)."
    continue
  fi

  found=$((found + 1))
  numbers="${numbers}${name%%-*}
"
done

if [ "${found}" -eq 0 ]; then
  report "В docs/decisions нет ни одного решения — журнал пуст."
fi

duplicates="$(printf '%s' "${numbers}" | sort | uniq -d)"

if [ -n "${duplicates}" ]; then
  for number in ${duplicates}; do
    same="$(cd "${decisions_directory}" && printf '%s ' "${number}"-*.md)"
    report "Номер ${number} выдан больше одного раза: ${same}"
  done
fi

if [ "${problems}" -ne 0 ]; then
  printf 'Журнал решений не в порядке: проблем — %s.\n' "${problems}" >&2
  exit 1
fi

printf 'Журнал решений в порядке: решений — %s, номера уникальны.\n' "${found}"
