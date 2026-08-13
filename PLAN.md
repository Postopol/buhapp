# GovFin Portal — План работы

## Стек
- React 19 + TypeScript + Vite (фронтенд, порт 3000)
- Express + better-sqlite3 + tsx (бэкенд, порт 3001)
- Tailwind CSS 4, lucide-react, recharts

## Статус по задачам

### Завершено
- [x] Бэкенд: `server/constants.ts`, `server/db.ts` (схема + seed), `server/auth.ts` (токены, middleware)
- [x] Бэкенд: routes — auth, requests (CRUD + advance), integrations (sync + logs), dashboard (kpis/ifp/alerts)
- [x] Бэкенд: `server/index.ts` (Express, порт 3001)
- [x] Фронтенд: `src/types/index.ts`, `src/services/` (api, auth, requests, integrations, dashboard)
- [x] Фронтенд: `AuthContext` переписан под реальный API
- [x] Фронтенд: `App.tsx` (loading-состояние), `Login.tsx` (реальная авторизация)
- [x] Фронтенд: `DashboardLayout.tsx` (убран демо-переключатель роли)
- [x] Фронтенд: `Dashboard.tsx`, `Workflow.tsx`, `Integrations.tsx` — моки заменены на API
- [x] Конфиги: vite proxy, tsconfig include, package.json scripts, .gitignore

### Не завершено
- [x] Финальная проверка типов (`npm run lint` / `tsc --noEmit`) — ошибок не найдено
- [x] Профилактика: @types/better-sqlite3, performSync catch, timeline safe access, engines
- [x] README.md с инструкциями
- [x] Runtime-тестирование — ВСЁ РАБОТАЕТ

### Результаты финальной проверки типов

Проверено 28 файлов исходного кода (8 в `server/`, 20 в `src/`) + `tsconfig.json`, `package.json`, `vite.config.ts`.

**Ошибок типов не найдено.** Исправления не требовались.

Ключевые выводы по проверенным точкам:

1. **`server/index.ts` — обработчик ошибок (строка 27):** 4-параметровый handler `(err: Error, _req, res, _next) => void` корректно типизирован. Проверено по реальным типам `@types/express-serve-static-core`: `app.use` имеет тип `ApplicationRequestHandler<T>`, включающий `((...handlers: RequestHandlerParams[]) => T)`. `RequestHandlerParams` — это `RequestHandler | ErrorRequestHandler | Array<...>`. Наша функция совместима с `ErrorRequestHandler` (т.к. `Error` assign-to `any`), поэтому попадает в union. Cast/`ErrorRequestHandler` не требуется.

2. **`server/auth.ts` — Express augmentation:** `declare global { namespace Express { interface Request { user?: AuthUser } } }` корректно augment'ит `Express.Request` (пустой интерфейс из `@types/express-serve-static-core`). `@types/express@^4.17.21` присутствует в devDependencies. `req.user` имеет тип `AuthUser | undefined`.

3. **`server/db.ts` — better-sqlite3 типы:** `@types/better-sqlite3` НЕ в devDependencies, и `better-sqlite3@12` не bundle'ит типы. Однако `tsconfig` не включает `strict` (значит `noImplicitAny` = OFF), а `allowJs: true` позволяет TS инферить типы из JS-файлов. Все `.get()`/`.all()` вызовы имеют `as`-cast'ы, что работает как с `unknown` (если бы типы были), так и с `any` (без типов). `Number(result.lastInsertRowid)` работает с `number | bigint`.

4. **`server/routes/requests.ts:102` — `EXPENSE_ITEMS.includes(expenseItem)`:** `EXPENSE_ITEMS` объявлен как обычный `const`-массив (не `as const`), поэтому TS инферит `string[]`. `Array<string>.includes(string)` — без ошибок. Cast не нужен.

5. **`src/pages/Workflow.tsx:233-235` — `request.timeline?.map` / `request.timeline!.length`:** Optional chaining `?.` гарантирует, что callback выполняется только когда `timeline` определён. Non-null assertion `!` внутри callback безопасен. `PaymentRequest.timeline` объявлен как опциональный (`timeline?: TimelineEntry[]`).

6. **`server/routes/integrations.ts:55-81` — `performSync`:** `resolve` вызывается во всех путях: при `!integration` (строка 61) и внутри `.then()` callback (строка 78). Это runtime-гарантия, не type issue.

7. **Дубликаты типов (`Role`, `RequestStatus`):** Сервер импортирует из `./constants` / `../constants`, клиент — из `@/types`. Cross-imports отсутствуют.

8. **`isolatedModules: true`:** Все type-only imports используют `import type` или inline `type` modifier (например, `import { ..., type LucideIcon } from 'lucide-react'`).

9. **`express.json()` middleware:** `req.body` имеет тип `ReqBody` (default `any`). В routes используются `as`-cast'ы — корректно.

10. **`corsMiddleware` (`server/auth.ts:100`):** Сигнатура `(req: Request, res: Response, next: NextFunction): void` — соответствует `RequestHandler`. Корректно передаётся в `app.use()`.

Важное замечание по конфигурации: `tsconfig.json` НЕ включает `strict: true`, поэтому `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes` отключены. Если в будущем включить `strict`, потребуется: добавить `@types/better-sqlite3` в devDeps, проверить все `req.user!` non-null assertions и `null`/`undefined` handling.

## Как запустить
```
npm install
npm run server    # терминал 1 — бэкенд на :3001
npm run dev       # терминал 2 — фронтенд на :3000
```

## Тестовые аккаунты
- Бухгалтер: `111111111111` / `pass123`
- Главбух: `222222222222` / `pass123`
- Руководитель: `333333333333` / `pass123`

## Сброс БД
Удалить `server/data/govfin.db` — при следующем запуске seed пересоздаст данные.

## Возможные проблемные места для проверки типов
1. `server/auth.ts` — `declare global { namespace Express }` (augmentation Express.Request)
2. `server/index.ts` — обработчик ошибок `express.ErrorRequestHandler` типизация
3. `src/services/api.ts` — дженерик `request<T>` и парсинг ответа
4. `server/routes/*.ts` — типы `Request`, `Response`, `NextFunction` из express
5. `src/pages/Workflow.tsx` — `request.timeline?.map` (timeline опционален в списке)
6. Дубликаты типов между `server/constants.ts` и `src/types/index.ts` (Role, RequestStatus)

## Code Review — исправленные критичные
- [x] 1. Ошибки advance показываются пользователю (actionError в detail view) — `src/pages/Workflow.tsx`
- [x] 2. GEMINI_API_KEY убран из клиентского бандла — `vite.config.ts`, `.env.example`
- [x] 3. Timing attack закрыт (timingSafeEqual) — `server/db.ts` verifyPassword
- [x] 4. Race condition ID — generateRequestId внутри транзакции — `server/routes/requests.ts`
- [x] 5. CORS через `CORS_ORIGIN` env — `server/auth.ts`
- [x] 6. Rate limiting на login (5 попыток → 60с блокировка, sweep старых записей, сброс после успеха) — `server/auth.ts`, `server/routes/auth.ts`

## Оставшиеся пункты code review (не закрыты)
- 7. Десинхрон состояния при 401 (токен в api.ts чистится, контекст не знает)
- 8. Аудит действий (заявлен «Все действия логируются», не реализован)
- 9. remaining кламп к 0 в dashboard/kpis
- 10. Протухшие сессии не чистятся
- 11. Тестовые креды на странице логина (оставить для демо, убрать для прода)
- 12. syncOne silent catch в Integrations
- 13. Дублирование типов между server/constants.ts и src/types
- 14. Двойной advance без защиты
- 15. Проверка владения заявкой при advance
- 16. Хвосты моков: «+12%», «Счет_на_оплату_№45.pdf»
- 17. Недетерминированный ORDER без вторичного ключа
- 18. ЭЦП кнопка-заглушка без onClick

## Дальнейшие доработки (после завершения текущей работы)
- Оптимистичные обновления в Workflow
- Polling/WebSocket для логов Integrations
- Pagination для логов (сейчас LIMIT 200)
- Валидация ИИН (12 цифр) на бэкенде
- README.md с инструкциями
