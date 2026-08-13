import { request, buildQuery, downloadUrl } from './api';
import type {
  ApprovalStatus,
  Attachment,
  BulkResult,
  Comment,
  Document,
  DocumentDetail,
  DocumentListResponse,
  DocType,
  OriginalStatus,
  PostingStatus,
  SavedView,
  Section,
} from '@/types';

export interface DocumentFilters {
  /** Фильтры собираются динамически из URL, поэтому нужен индексный доступ. */
  [key: string]: string | number | undefined;
  search?: string;
  type?: string;
  section?: string;
  approval?: string;
  original?: string;
  payment?: string;
  posting?: string;
  counterparty?: string;
  period?: string;
  responsible?: string;
  overdue?: string;
  mine?: string;
  sort?: string;
  dir?: string;
  limit?: number;
  offset?: number;
}

export function listDocuments(filters: DocumentFilters): Promise<DocumentListResponse> {
  return request(`/documents${buildQuery(filters)}`);
}

export function getDocument(id: number): Promise<{ document: DocumentDetail }> {
  return request(`/documents/${id}`);
}

export interface DocumentInput {
  type: DocType;
  number: string;
  docDate: string;
  dueDate?: string | null;
  counterpartyId?: number | null;
  contractId?: number | null;
  expenseItemId?: number | null;
  amount: number;
  vat?: number;
  purpose?: string;
  section: Section;
  responsibleId?: number | null;
}

export function createDocument(data: DocumentInput): Promise<{ document: Document }> {
  return request('/documents', { method: 'POST', body: JSON.stringify(data) });
}

export function updateDocument(id: number, data: Partial<DocumentInput>): Promise<{ document: Document }> {
  return request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function transitionDocument(
  id: number,
  to: ApprovalStatus,
  comment?: string
): Promise<{ document: Document }> {
  return request(`/documents/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to, comment }),
  });
}

export function bulkTransition(ids: number[], to: ApprovalStatus, comment?: string): Promise<BulkResult> {
  return request('/documents/bulk/transition', {
    method: 'POST',
    body: JSON.stringify({ ids, to, comment }),
  });
}

export function setOriginalStatus(id: number, status: OriginalStatus): Promise<{ document: Document }> {
  return request(`/documents/${id}/original`, { method: 'POST', body: JSON.stringify({ status }) });
}

export function setPostingStatus(id: number, status: PostingStatus): Promise<{ document: Document }> {
  return request(`/documents/${id}/posting`, { method: 'POST', body: JSON.stringify({ status }) });
}

export function addComment(id: number, body: string): Promise<{ comment: Comment }> {
  return request(`/documents/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

// ── Сохранённые фильтры ─────────────────────────────────────────────────────

export function listViews(): Promise<{ views: SavedView[] }> {
  return request('/views');
}

export function createView(data: {
  name: string;
  query: Record<string, string>;
  shared?: boolean;
}): Promise<{ view: SavedView }> {
  return request('/views', { method: 'POST', body: JSON.stringify(data) });
}

export function renameView(id: number, name: string): Promise<{ view: SavedView }> {
  return request(`/views/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export function updateViewQuery(id: number, query: Record<string, string>): Promise<{ view: SavedView }> {
  return request(`/views/${id}`, { method: 'PATCH', body: JSON.stringify({ query }) });
}

export function deleteView(id: number): Promise<{ ok: boolean }> {
  return request(`/views/${id}`, { method: 'DELETE' });
}

export function exportUrl(filters: DocumentFilters): string {
  return downloadUrl(`/documents/export.csv${buildQuery(filters)}`);
}

// ── Вложения ────────────────────────────────────────────────────────────────

export function uploadAttachment(
  documentId: number,
  file: File
): Promise<{ attachment: Attachment }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      request<{ attachment: Attachment }>(`/attachments/documents/${documentId}`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          mime: file.type,
          data: String(reader.result),
        }),
      }).then(resolve, reject);
    };
    reader.readAsDataURL(file);
  });
}

export function deleteAttachment(id: number): Promise<{ ok: boolean }> {
  return request(`/attachments/${id}`, { method: 'DELETE' });
}

export function attachmentUrl(id: number): string {
  return downloadUrl(`/attachments/${id}/download`);
}
