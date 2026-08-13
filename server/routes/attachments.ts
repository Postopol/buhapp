import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync, createReadStream } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { db, nowTimestamp, logAudit, UPLOAD_DIR } from '../db';
import { requireAuth } from '../auth';
import { MAX_ATTACHMENT_BYTES, ALLOWED_ATTACHMENT_MIME } from '../../shared/domain';

export const attachmentsRouter = Router();

attachmentsRouter.use(requireAuth);

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

/** Инициатор работает только со своими документами. */
function documentVisible(documentId: number, userId: number, role: string): boolean {
  const row = db.prepare('SELECT created_by FROM documents WHERE id = ?').get(documentId) as
    | { created_by: number | null }
    | undefined;
  if (!row) return false;
  if (role === 'initiator') return row.created_by === userId;
  return true;
}

const SAFE_EXT = /^\.[A-Za-z0-9]{1,8}$/;

attachmentsRouter.post('/documents/:id(\\d+)', (req, res) => {
  const documentId = Number(req.params.id);
  const user = req.user!;
  if (!documentVisible(documentId, user.id, user.role)) {
    res.status(404).json({ error: 'Документ не найден' });
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

  let buffer: Buffer;
  try {
    // Клиент присылает содержимое как data-URL или чистый base64.
    const payload = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    buffer = Buffer.from(payload, 'base64');
  } catch {
    res.status(400).json({ error: 'Не удалось прочитать файл' });
    return;
  }
  if (buffer.length === 0) {
    res.status(400).json({ error: 'Файл пустой' });
    return;
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    res.status(413).json({ error: `Файл больше ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} МБ` });
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
  if (!row || !documentVisible(row.document_id, user.id, user.role)) {
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
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  );
  createReadStream(path).pipe(res);
});

attachmentsRouter.delete('/:id(\\d+)', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id)) as
    | AttachmentRow
    | undefined;
  const user = req.user!;
  if (!row || !documentVisible(row.document_id, user.id, user.role)) {
    res.status(404).json({ error: 'Файл не найден' });
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
