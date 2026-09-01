// Первым импортом: dotenv лежал в зависимостях, но не подключался нигде, и
// .env молча игнорировался — администратор, прописавший туда CORS_ORIGIN или
// DB_PATH, получал молчаливые значения по умолчанию. Порядок важен: остальные
// модули читают process.env прямо при загрузке.
import 'dotenv/config';
import express from 'express';
import { corsMiddleware } from './auth';
import { nowTimestamp } from './db';
import { authRouter } from './routes/auth';
import { documentsRouter } from './routes/documents';
import { counterpartiesRouter } from './routes/counterparties';
import { paymentsRouter } from './routes/payments';
import { workspaceRouter } from './routes/workspace';
import { attachmentsRouter } from './routes/attachments';
import { periodsRouter } from './routes/periods';
import { taxesRouter } from './routes/taxes';
import { viewsRouter } from './routes/views';
import { reconciliationsRouter } from './routes/reconciliations';

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * За nginx или облачным балансировщиком req.ip — это адрес прокси, и лимит
 * попыток входа считался бы сразу на всех. Включать доверие к
 * X-Forwarded-For по умолчанию нельзя: без прокси заголовок подделывает кто
 * угодно и обходит лимит. Значение — то же, что понимает express: число
 * хопов, «loopback» или список адресов.
 */
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

/**
 * Токен скачивания приходит в query. В журнал он попасть не должен — иначе
 * лог сам становится связкой ключей от всех открытых сессий.
 */
function maskToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, '$1***');
}

/**
 * Компактный журнал обращений. Без него в проде не видно ни всплеска 500-х,
 * ни того, кто и что дёргал перед падением: были только строка при старте и
 * console.error на необработанной ошибке. Внешний логгер не берём — одной
 * строки на запрос достаточно, а зависимостей у сервера и так минимум.
 */
app.use((req, res, next) => {
  const startedNs = process.hrtime.bigint();
  // Именно 'finish', а не обёртка над res.json: так в лог попадают и отдача
  // файла потоком, и ответы, сформированные самим express (404, 500).
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
    console.log(
      `${nowTimestamp()} ${req.method} ${maskToken(req.originalUrl)} ${res.statusCode} ` +
        `${ms.toFixed(0)}ms user=${req.user?.id ?? '-'}`
    );
  });
  next();
});

app.use(corsMiddleware);

// Вложения приходят как base64 внутри JSON: 15 МБ файла превращаются в 20 МБ
// тела. Большой лимит нужен только им — раньше он действовал на все маршруты,
// включая неавторизованный POST /api/auth/login, и аноним мог заставить
// однопоточный процесс разбирать 25 МБ на каждый запрос.
app.use('/api/attachments', express.json({ limit: '25mb' }));
// Остальным хватает обычного, но не стандартных 100 КБ: в акт сверки
// вставляют выписку контрагента до 500 строк текстом.
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/counterparties', counterpartiesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/periods', periodsRouter);
app.use('/api/taxes', taxesRouter);
app.use('/api/views', viewsRouter);
app.use('/api/reconciliations', reconciliationsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

/** Ошибка «как её видит express»: статус кладут и в status, и в statusCode. */
interface HandledError extends Error {
  status?: number;
  statusCode?: number;
  /** Код SQLite из better-sqlite3, например SQLITE_CONSTRAINT_UNIQUE. */
  code?: string;
  /** Разновидность ошибки body-parser, например entity.parse.failed. */
  type?: string;
}

/**
 * Понятный текст на частые нарушения UNIQUE. Ключ — то, что SQLite пишет в
 * сообщении после «UNIQUE constraint failed: ».
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  'counterparties.bin': 'Контрагент с таким БИН уже заведён',
  'users.email': 'Пользователь с такой почтой уже есть',
  'expense_items.code': 'Статья расходов с таким кодом уже есть',
  'reconciliations.number': 'Акт сверки с таким номером уже есть',
  'document_payments.document_id, document_payments.payment_id':
    'Этот платёж уже разнесён на документ — поправьте существующее разнесение',
  'tax_events.code, tax_events.period': 'Это налоговое событие за период уже заведено',
  'periods.period': 'Период уже заведён',
};

/**
 * Ограничения БД — это почти всегда ошибка пользователя, а не сервера: дубль
 * БИН при правке контрагента, повторное разнесение платежа, ссылка на
 * удалённого ответственного. Все они уходили клиенту как «Внутренняя ошибка
 * сервера», и разобраться, что именно не так, было нельзя.
 */
function sqliteResponse(err: HandledError): { status: number; error: string } | null {
  if (!err.code || !err.code.startsWith('SQLITE_')) return null;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const columns = err.message.split('constraint failed: ')[1]?.trim() ?? '';
    return { status: 409, error: UNIQUE_MESSAGES[columns] ?? 'Такая запись уже есть' };
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return {
      status: 400,
      error:
        'Ссылка на несуществующую запись: проверьте контрагента, договор, статью расходов и ответственного',
    };
  }
  if (err.code === 'SQLITE_CONSTRAINT_CHECK' || err.code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return {
      status: 400,
      error: 'База не приняла значение: проверьте суммы, статусы и обязательные поля',
    };
  }
  return null;
}

/** Ошибки разбора тела запроса: у них свой status, но текст — английский. */
const BODY_ERRORS: Record<string, string> = {
  'entity.parse.failed': 'Некорректный JSON в теле запроса',
  'entity.too.large': 'Тело запроса слишком велико',
  'entity.verify.failed': 'Тело запроса не прошло проверку',
  'encoding.unsupported': 'Неподдерживаемая кодировка тела запроса',
  'request.aborted': 'Запрос прерван на середине',
};

app.use((err: HandledError, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Заголовки уже ушли (например, оборвалась отдача вложения потоком) —
  // дописать JSON поверх нельзя, отдаём ошибку express'у на закрытие.
  if (res.headersSent) {
    next(err);
    return;
  }

  const sqlite = sqliteResponse(err);
  if (sqlite) {
    console.error(`Ограничение БД на ${req.method} ${maskToken(req.originalUrl)}: ${err.message}`);
    res.status(sqlite.status).json({ error: sqlite.error });
    return;
  }

  // Кривое тело запроса — вина клиента: express кладёт в ошибку 400, а
  // обработчик всё равно отвечал 500, и «Внутренняя ошибка сервера»
  // отправляла разбираться не туда.
  const status = Number(err.status ?? err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    res.status(status).json({ error: (err.type && BODY_ERRORS[err.type]) || 'Некорректный запрос' });
    return;
  }

  console.error(`Необработанная ошибка на ${req.method} ${maskToken(req.originalUrl)}:`, err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`API бухотдела запущен на http://localhost:${PORT}`);
});
