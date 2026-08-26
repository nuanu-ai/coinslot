# Coinslot

Шлюз, через который классический интернет-магазин продаёт свои товары
ИИ-агентам за стейблкоины по протоколу x402. Что это и зачем — `docs/vision.md`.

Стадия — этап 0 плана пилота (`docs/research/21-pilot-plan.md`): каркас
монорепо поднят, дальше — контракты кодом и машина состояний заказа.

- Принятые решения — `docs/decisions/` (экспозиция каталога, модель
  интеграции, стек)
- Рабочие материалы исследования — `docs/research/`
- Документация для подключающихся магазинов — `portal/` (отдельный проект:
  `cd portal && pnpm install && pnpm docs:dev`)
- Код — `packages/` (contracts, core, sdk) и `apps/gateway`. Проверки:
  `pnpm install`, затем `pnpm check`, `pnpm typecheck`, `pnpm test`,
  `pnpm check:decisions`
