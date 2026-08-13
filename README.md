# GovFin Portal

MVP веб-портала для автоматизации внутренних процессов бухгалтерии государственного органа.

## Технологии

- **Фронтенд:** React 19, TypeScript, Vite, Tailwind CSS 4, lucide-react, recharts
- **Бэкенд:** Express, better-sqlite3, tsx
- **Аутентификация:** токены (crypto.randomUUID), сессии в БД, пароли через scrypt

## Требования

- Node.js >= 20
- npm

## Установка и запуск

```bash
npm install

# Терминал 1 — бэкенд (порт 3001)
npm run server

# Терминал 2 — фронтенд (порт 3000)
npm run dev
```

Открыть: http://localhost:3000

## Тестовые аккаунты

| Роль | ИИН | Пароль |
|------|-----|--------|
| Бухгалтер | `111111111111` | `pass123` |
| Главный бухгалтер | `222222222222` | `pass123` |
| Руководитель | `333333333333` | `pass123` |

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск фронтенда (Vite, порт 3000) |
| `npm run server` | Запуск бэкенда (tsx watch, порт 3001) |
| `npm run build` | Сборка фронтенда |
| `npm run lint` | Проверка типов (tsc --noEmit) |
| `npm run clean` | Удаление dist |

## Структура

```
server/
  index.ts              — точка входа Express
  db.ts                 — инициализация БД, миграции, seed
  auth.ts               — токены, middleware, CORS
  constants.ts          — общие типы и константы
  routes/
    auth.ts             — login / logout / me
    requests.ts         — заявки (CRUD + смена статуса)
    integrations.ts     — интеграции (синхронизация + логи)
    dashboard.ts        — KPI, ИПФ, уведомления
  data/                 — файл SQLite (gitignore)

src/
  pages/                — Dashboard, Workflow, Integrations, Login
  layouts/              — DashboardLayout
  components/ui/        — UI-кит (button, card, badge, input, table)
  context/              — AuthContext
  services/             — API-обёртки (api, auth, requests, integrations, dashboard)
  types/                — общие типы
  lib/utils.ts          — утилита cn()
```

## Возможности

- Аутентификация по ИИН/паролю с сохранением сессии
- Ролевая модель: бухгалтер, главный бухгалтер, руководитель
- Дашборд: KPI бюджета, график ИПФ по спецификам, уведомления
- Заявки на оплату: создание, маршрут согласования (черновик → финотдел → главбух → казначейство), таймлайн
- Интеграции: синхронизация с внешними системами (e-Qyzmet, Казначейство, OAG), логи
- Поиск и фильтрация по заявкам и логам

## Сброс БД

Удалить `server/data/govfin.db` — при следующем запуске `npm run server` seed пересоздаст данные.
