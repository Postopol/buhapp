import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync, createReadStream } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { db, nowTimestamp, logAudit, isPeriodClosed, UPLOAD_DIR } from '../db';
import { requireAuth, requireRole } from '../auth';
import { MAX_ATTACHMENT_BYTES, ALLOWED_ATTACHMENT_MIME } from '../../shared/domain';

export const attachmentsRouter = Router();

attachmentsRouter.use(requireAuth);

/**
 * Руководитель по матрице ролей только смотрит: скачать вложение он может,
 * а загружать и удалять — нет. Раньше правило «только свой файл» проверялось
 * лишь у инициатора, и директор спокойно чистил чужие вложения.
 */
const canWrite = requireRole('initiator', 'accountant', 'chief_accountant');

interface AttachmentRow {
  id: number;
  document_id: number;
  filename: string;
  mime: string;
  size: number;
  stored_name: string;
  uploaded_by: number | null;
  uploaded_at: string;
}

interface DocMeta {
  created_by: number | null;
  period: string;
}

/** Инициатор работает только со своими документами. */
function documentFor(documentId: number, userId: number, role: string): DocMeta | undefined {
  const row = db.prepare('SELECT created_by, period FROM documents WHERE id = ?').get(documentId) as
    | DocMeta
    | undefined;
  if (!row) return undefined;
  if (role === 'initiator' && row.created_by !== userId) return undefined;
  return row;
}

/** Зеркало блокировки из documents.ts: закрытый месяц не меняется вообще ничем. */
const PERIOD_LOCKED = 'Период закрыт — вложения документа менять нельзя. Обратитесь к главному бухгалтеру.';

const SAFE_EXT = /^\.[A-Za-z0-9]{1,8}$/;

/**
 * Строгая маска base64 с обязательным паддингом. Отдельная проверка нужна
 * потому, что `Buffer.from(x, 'base64')` не бросает исключений: он молча
 * выбрасывает недопустимые символы, и обрезанный или битый ввод превращался
 * в укороченный файл, который принимался как валидный.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * MIME присылает клиент, то есть это пожелание, а не факт: переименованный
 * файл приезжает с любым заголовком. Сверяем сигнатуру там, где она
 * однозначна. Для docx/xlsx проверки нет намеренно — это zip-контейнеры,
 * и их сигнатура не отличает документ от произвольного архива.
 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  // Спека PDF разрешает мусор перед заголовком, и часть сканеров этим пользуется,
  // поэтому ищем «%PDF-» в начале файла, а не строго в нулевом байте.
  'application/pdf': (b) => b.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') !== -1,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

attachmentsRouter.post('/documents/:id(\\d+)', canWrite, (req, res) => {
  const documentId = Number(req.params.id);
  const user = req.user!;
  const doc = documentFor(documentId, user.id, user.role);
  if (!doc) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  if (isPeriodClosed(doc.period)) {
    res.status(409).json({ error: PERIOD_LOCKED });
    return;
  }

  const { filename, mime, data } = req.body as { filename?: string; mime?: string; data?: string };
  if (!filename || !filename.trim()) {
    res.status(400).json({ error: 'Не указано имя файла' });
    return;
  }
  if (!mime || !ALLOWED_ATTACHMENT_MIME.includes(mime)) {
    res.status(400).json({ error: 'Такой тип файла не принимается. Разрешены PDF, изображения, Word и Excel' });
    return;
  }
  if (!data) {
    res.status(400).json({ error: 'Файл пустой' });
    return;
  }

  // Клиент присылает содержимое как data-URL или чистый base64.
  const payload = (data.includes(',') ? data.slice(data.indexOf(',') + 1) : data).replace(/\s/g, '');
  if (!BASE64_RE.test(payload)) {
    res.status(400).json({ error: 'Не удалось прочитать файл: содержимое повреждено' });
    return;
  }
  const buffer = Buffer.from(payload, 'base64');

  if (buffer.length === 0) {
    res.status(400).json({ error: 'Файл пустой' });
    return;
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    res.status(413).json({ error: `Файл больше ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} МБ` });
    return;
  }
  const magic = MAGIC[mime];
  if (magic && !magic(buffer)) {
    res.status(400).json({ error: 'Содержимое файла не совпадает с его типом' });
    return;
  }

  // Имя на диске генерируем сами — пользовательское в путь не попадает.
  const cleanName = basename(filename.trim()).slice(0, 200);
  const ext = extname(cleanName).toLowerCase();
  const storedName = `${randomUUID()}${SAFE_EXT.test(ext) ? ext : ''}`;
  writeFileSync(join(UPLOAD_DIR, storedName), buffer);

  const ts = nowTimestamp();
  const info = db
    .prepare(
      `INSERT INTO attachments (document_id, filename, mime, size, stored_name, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(documentId, cleanName, mime, buffer.length, storedName, user.id, ts);

  db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(ts, documentId);

  // Первый приложенный файл автоматически переводит оригинал в «скан» —
  // иначе этот статус никто никогда не проставит вручную.
  const current = db.prepare('SELECT original_status FROM documents WHERE id = ?').get(documentId) as {
    original_status: string;
  };
  if (current.original_status === 'none') {
    db.prepare(`UPDATE documents SET original_status = 'scan' WHERE id = ?`).run(documentId);
  }

  logAudit({
    entityType: 'document',
    entityId: documentId,
    action: 'attachment_added',
    userId: user.id,
    userName: user.name,
    details: { filename: cleanName, size: buffer.length },
  });

  res.status(201).json({
    attachment: {
      id: Number(info.lastInsertRowid),
      filename: cleanName,
      mime,
      size: buffer.length,
      uploadedAt: ts,
      uploadedByName: user.name,
    },
  });
});

attachmentsRouter.get('/:id(\\d+)/download', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id)) as
    | AttachmentRow
    | undefined;
  const user = req.user!;
  if (!row || !documentFor(row.document_id, user.id, user.role)) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  const path = join(UPLOAD_DIR, row.stored_name);
  if (!existsSync(path)) {
    res.status(410).json({ error: 'Файл отсутствует на диске' });
    return;
  }
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Length', String(row.size));
  // Запрещаем браузеру угадывать тип: иначе он может исполнить как HTML файл,
  // который мы отдаём под безобидным заголовком.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  );
  createReadStream(path).pipe(res);
});

attachmentsRouter.delete('/:id(\\d+)', canWrite, (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id)) as
    | AttachmentRow
    | undefined;
  const user = req.user!;
  const doc = row ? documentFor(row.document_id, user.id, user.role) : undefined;
  if (!row || !doc) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  if (isPeriodClosed(doc.period)) {
    res.status(409).json({ error: PERIOD_LOCKED });
    return;
  }
  if (user.role === 'initiator' && row.uploaded_by !== user.id) {
    res.status(403).json({ error: 'Удалить можно только свой файл' });
    return;
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  const path = join(UPLOAD_DIR, row.stored_name);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Запись в БД уже удалена — осиротевший файл не повод падать.
  }

  logAudit({
    entityType: 'document',
    entityId: row.document_id,
    action: 'attachment_removed',
    userId: user.id,
    userName: user.name,
    details: { filename: row.filename },
  });

  res.json({ ok: true });
});
