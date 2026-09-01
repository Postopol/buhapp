/**
 * Арифметика акта сверки: сальдо на начало, обороты за период, сальдо на конец.
 *
 * Знак один на весь модуль: **положительное сальдо — мы должны контрагенту**.
 * Это кредиторская задолженность, и в этом приложении она основная — портал
 * ведёт расчёты с поставщиками.
 *
 * Тождество, которое обязано выполняться всегда:
 *
 *     сальдо на конец = сальдо на начало + начислено − оплачено
 *
 * Оно держится за счёт того, что обе стороны отсекаются по своим датам:
 * документы — по `doc_date`, оплаты — по `payment_date` платежа (а не по дате
 * документа, на который платёж разнесён). Иначе оплата января по декабрьскому
 * счёту потерялась бы между периодами.
 *
 * Отклонённые документы не создают долга и потому исключены с обеих сторон —
 * и из начислений, и из привязанных к ним оплат. Исключать их только из одной
 * половины нельзя: тождество разъедется.
 *
 * Счёт, закрытый актом или накладной, начисляется один раз — по закрывающему
 * документу (см. NOT_CLOSED). Тождество от этого не страдает: правило одно
 * и для сальдо на начало, и для оборотов, поэтому сцепка периодов держится —
 * конец января равен началу февраля при любой расстановке связей.
 */

import { db } from './db';
import { DOC_TYPE_SHORT, type DocType } from '../shared/domain';

/** Отклонённые документы не участвуют в расчётах — условие одно на все запросы. */
const NOT_REJECTED = `d.approval_status <> 'rejected'`;

/**
 * Счёт на оплату сам по себе обязательства не создаёт — начисление создаёт
 * закрывающий документ (акт выполненных работ, накладная). Пока связи не было,
 * обычный поток «завели счёт → оплатили → пришёл акт» задваивал сальдо: счёт
 * и акт складывались оба. Поэтому из НАЧИСЛЕНИЙ выпадает документ, на который
 * ссылается `closes_document_id` другого не отклонённого документа.
 *
 * Из ОПЛАТ счёт не исключается: платежи разносятся именно на него, он остаётся
 * носителем оплаты. Отсюда асимметрия — условие стоит только в начислениях.
 *
 * Правило обязано дословно совпадать с BALANCE_SELECT в routes/counterparties.ts:
 * акт сверки за всю историю сходится с долгом на карточке контрагента до тиына,
 * и разъехавшиеся правила разъедут эти две цифры молча.
 */
const NOT_CLOSED = `NOT EXISTS (
           SELECT 1 FROM documents c
           WHERE c.closes_document_id = d.id AND c.id <> d.id
             AND c.approval_status <> 'rejected'
         )`;

export interface TurnoverLine {
  kind: 'document' | 'payment';
  documentId: number | null;
  paymentId: number | null;
  date: string;
  title: string;
  /** Расшифровка: назначение документа или что закрыл платёж. */
  purpose: string;
  /** Начислено — растит наш долг. */
  accrued: number;
  /** Оплачено — гасит наш долг. */
  paid: number;
  /** НДС внутри суммы документа. Нужен подсказке «расхождение равно НДС». */
  vat: number;
}

export interface Statement {
  counterpartyId: number;
  from: string;
  to: string;
  opening: number;
  accrued: number;
  paid: number;
  closing: number;
  /** Из них ещё не согласовано внутри компании — в сальдо входит, но об этом предупреждаем. */
  unapproved: number;
  unapprovedCount: number;
  /** Неразнесённый остаток платежей контрагента — вероятный аванс, в сальдо НЕ входит. */
  unallocated: number;
  /** Что выкинуло правило «отклонённые не в счёт» — ответ на «почему не сходится». */
  excluded: number;
  excludedCount: number;
  /**
   * Оплаты по отклонённым документам, отсечённые по дате ПЛАТЕЖА. Считаются
   * отдельно от `excluded` и складывать их нельзя: у них разная база отсечения
   * и они попадают в разные периоды.
   */
  excludedPaid: number;
  excludedPaidCount: number;
  /**
   * Пары «счёт и акт на одну сумму» без проставленной связи — вероятный
   * двойной счёт одной услуги. `hint` говорит, чем пару закрыть.
   */
  duplicates: { amount: number; numbers: string; hint: string }[];
  lines: TurnoverLine[];
}

/**
 * Сальдо на начало дня `from` — всё, что случилось строго раньше.
 */
export function openingBalance(counterpartyId: number, from: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(d.amount_minor) FROM documents d
           WHERE d.counterparty_id = ? AND ${NOT_REJECTED} AND ${NOT_CLOSED}
             AND d.doc_date < ?
         ), 0) AS accrued,
         COALESCE((
           SELECT SUM(dp.amount_minor)
           FROM document_payments dp
           JOIN payments p ON p.id = dp.payment_id
           JOIN documents d ON d.id = dp.document_id
           WHERE d.counterparty_id = ? AND ${NOT_REJECTED} AND p.payment_date < ?
         ), 0) AS paid`
    )
    .get(counterpartyId, from, counterpartyId, from) as { accrued: number; paid: number };

  return row.accrued - row.paid;
}

interface DocLineRow {
  id: number;
  type: DocType;
  number: string;
  doc_date: string;
  amount_minor: number;
  vat_minor: number;
  purpose: string;
}

interface PayLineRow {
  payment_id: number;
  payment_date: string;
  reference: string;
  amount_minor: number;
  covered: string;
}

/**
 * Обороты за период: документы по дате документа, оплаты по дате платежа.
 * Строки идут в хронологии — так акт и читают, сверху вниз.
 */
export function turnover(counterpartyId: number, from: string, to: string): TurnoverLine[] {
  const docs = db
    .prepare(
      `SELECT d.id, d.type, d.number, d.doc_date, d.amount_minor, d.vat_minor, d.purpose
       FROM documents d
       WHERE d.counterparty_id = ? AND ${NOT_REJECTED} AND ${NOT_CLOSED}
         AND d.doc_date >= ? AND d.doc_date <= ?
       ORDER BY d.doc_date, d.id`
    )
    .all(counterpartyId, from, to) as DocLineRow[];

  // Группировка по платежу, а не по разнесению: контрагент видит одно платёжное
  // поручение и одной строкой его и покажет. Суммируется только dp.amount_minor
  // по документам ЭТОГО контрагента — один платёж режется на разных, и брать
  // p.amount_minor значило бы затащить в акт чужие деньги.
  //
  // NOT_CLOSED здесь намеренно нет: счёт, закрытый актом, из начислений вышел,
  // но носителем оплаты остался. Убрать его отсюда значило бы потерять живые
  // деньги с расчётного счёта и сломать тождество.
  const pays = db
    .prepare(
      `SELECT p.id AS payment_id, p.payment_date, p.reference,
              SUM(dp.amount_minor) AS amount_minor,
              GROUP_CONCAT(d.number, ', ') AS covered
       FROM document_payments dp
       JOIN payments p ON p.id = dp.payment_id
       JOIN documents d ON d.id = dp.document_id
       WHERE d.counterparty_id = ? AND ${NOT_REJECTED} AND p.payment_date >= ? AND p.payment_date <= ?
       GROUP BY p.id
       ORDER BY p.payment_date, p.id`
    )
    .all(counterpartyId, from, to) as PayLineRow[];

  const lines: TurnoverLine[] = [
    ...docs.map((d) => ({
      kind: 'document' as const,
      documentId: d.id,
      paymentId: null,
      date: d.doc_date,
      title: `${DOC_TYPE_SHORT[d.type]} ${d.number}`,
      purpose: d.purpose,
      accrued: d.amount_minor,
      paid: 0,
      vat: d.vat_minor,
    })),
    ...pays.map((p) => ({
      kind: 'payment' as const,
      documentId: null,
      paymentId: p.payment_id,
      date: p.payment_date,
      title: p.reference ? `Оплата ${p.reference}` : `Оплата №${p.payment_id}`,
      purpose: p.covered ? `в счёт ${p.covered}` : '',
      accrued: 0,
      paid: p.amount_minor,
      vat: 0,
    })),
  ];

  // Дата, затем начисление раньше оплаты (счёт не может быть оплачен до того,
  // как выставлен), затем id — порядок обязан быть детерминированным.
  lines.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'document' ? -1 : 1;
    return (a.documentId ?? a.paymentId ?? 0) - (b.documentId ?? b.paymentId ?? 0);
  });

  return lines;
}

/**
 * Сколько в обороты попало документов, которые внутри компании ещё не
 * согласованы. Они входят в сальдо — так же, как в карточке контрагента, —
 * но контрагенту уходит сумма, по которой решение не принято, и об этом
 * бухгалтер обязан узнать до отправки, а не после.
 *
 * NOT_CLOSED здесь такой же, как в начислениях: предупреждение обещает
 * «вошло в сальдо», и считать в нём счёт, которого в сальдо нет, — врать.
 */
function unapprovedInRange(
  counterpartyId: number,
  from: string,
  to: string
): { amount: number; count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(d.amount_minor), 0) AS amount, COUNT(*) AS count
       FROM documents d
       WHERE d.counterparty_id = ? AND ${NOT_CLOSED}
         AND d.approval_status IN ('draft','review','returned')
         AND d.doc_date >= ? AND d.doc_date <= ?`
    )
    .get(counterpartyId, from, to) as { amount: number; count: number };
  return row;
}

/**
 * Неразнесённый остаток платежей, которые легли на документы этого
 * контрагента. К контрагенту такой остаток не привязан ничем, кроме этого
 * косвенного признака (у платежа своего контрагента нет), поэтому в сальдо
 * он не идёт — только в предупреждение «похоже на аванс».
 *
 * Берутся лишь платежи, ВСЕ разнесения которых ушли этому контрагенту.
 * Платёж, разбитый между несколькими, остатка не даёт: раньше остаток целиком
 * приписывался каждому задетому контрагенту, и один и тот же «аванс» на
 * 30 000 всплывал в акте и у А, и у Б. Делить остаток пропорционально значило
 * бы выдумать цифру — предупреждение молчит, пока платёж не разнесут.
 *
 * Отклонённые документы, как и везде в модуле, признаком не считаются: долга
 * они не создают, и аванс по ним объяснять нечем.
 */
function unallocatedFor(counterpartyId: number, from: string, to: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_minor - alloc.total), 0) AS rest
       FROM payments p
       JOIN (
         SELECT payment_id, SUM(amount_minor) AS total
         FROM document_payments GROUP BY payment_id
       ) alloc ON alloc.payment_id = p.id
       WHERE p.payment_date >= ? AND p.payment_date <= ?
         AND alloc.total < p.amount_minor
         AND EXISTS (
           SELECT 1 FROM document_payments dp
           JOIN documents d ON d.id = dp.document_id
           WHERE dp.payment_id = p.id AND d.counterparty_id = ? AND ${NOT_REJECTED}
         )
         AND NOT EXISTS (
           SELECT 1 FROM document_payments dp2
           JOIN documents d2 ON d2.id = dp2.document_id
           WHERE dp2.payment_id = p.id
             AND (d2.counterparty_id IS NULL OR d2.counterparty_id <> ?)
         )`
    )
    .get(from, to, counterpartyId, counterpartyId) as { rest: number };
  return row.rest;
}

/** Сколько отбросило правило «отклонённые не создают долга». */
function excludedInRange(
  counterpartyId: number,
  from: string,
  to: string
): { amount: number; count: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(d.amount_minor), 0) AS amount, COUNT(*) AS count
       FROM documents d
       WHERE d.counterparty_id = ? AND d.approval_status = 'rejected'
         AND d.doc_date >= ? AND d.doc_date <= ?`
    )
    .get(counterpartyId, from, to) as { amount: number; count: number };
}

/**
 * Оплаты, выпавшие из оборотов вместе с отклонёнными документами.
 *
 * Считать их по дате документа нельзя: оплаты отсекаются по `payment_date`,
 * и объяснение обязано пользоваться той же осью. Иначе деньги, ушедшие
 * с расчётного счёта в феврале по январскому счёту, который потом отклонили,
 * пропадут из февральского акта совершенно молча — а контрагент их покажет.
 */
function excludedPaidInRange(
  counterpartyId: number,
  from: string,
  to: string
): { amount: number; count: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(dp.amount_minor), 0) AS amount, COUNT(DISTINCT p.id) AS count
       FROM document_payments dp
       JOIN payments p ON p.id = dp.payment_id
       JOIN documents d ON d.id = dp.document_id
       WHERE d.counterparty_id = ? AND d.approval_status = 'rejected'
         AND p.payment_date >= ? AND p.payment_date <= ?`
    )
    .get(counterpartyId, from, to) as { amount: number; count: number };
}

/**
 * Счёт на оплату сам по себе обязательства не создаёт — его создаёт акт или
 * накладная. Если за период есть и счёт, и акт на ровно одну сумму, а связь
 * между ними не проставлена, услуга почти наверняка посчитана дважды,
 * и контрагент это заметит. Приложение не решает за бухгалтера, а показывает
 * пару и говорит, чем её закрыть.
 *
 * Связанная пара молчит: по ней начисление уже одно — счёт из оборотов вышел
 * по NOT_CLOSED, задваивать нечего.
 *
 * Пары ищутся самосоединением, а не группировкой по сумме: связь стоит между
 * двумя конкретными документами, и группа «всё на 120 000» проверить её
 * не даёт — одна проставленная связь глушила бы предупреждение по остальным.
 */
function duplicatePairs(
  counterpartyId: number,
  from: string,
  to: string
): { amount: number; numbers: string; hint: string }[] {
  const pairs = db
    .prepare(
      `SELECT a.amount_minor AS amount, a.number AS first_number, b.number AS second_number
       FROM documents a
       JOIN documents b
         ON b.counterparty_id = a.counterparty_id
        AND b.amount_minor = a.amount_minor
        AND b.id > a.id
        AND b.type <> a.type
       WHERE a.counterparty_id = ?
         AND a.approval_status <> 'rejected' AND b.approval_status <> 'rejected'
         AND a.type IN ('invoice','act','waybill') AND b.type IN ('invoice','act','waybill')
         AND a.doc_date >= ? AND a.doc_date <= ?
         AND b.doc_date >= ? AND b.doc_date <= ?
         AND (a.closes_document_id IS NULL OR a.closes_document_id <> b.id)
         AND (b.closes_document_id IS NULL OR b.closes_document_id <> a.id)
       ORDER BY a.amount_minor DESC, a.id, b.id`
    )
    .all(counterpartyId, from, to, from, to) as {
    amount: number;
    first_number: string;
    second_number: string;
  }[];

  return pairs.map((p) => ({
    amount: p.amount,
    numbers: `${p.first_number} и ${p.second_number}`,
    hint: 'Если один документ закрывает другой, укажите это в закрывающем документе — тогда начисление останется одно, а счёт останется носителем оплаты',
  }));
}

/** Полная оборотная ведомость по контрагенту за период. */
export function statement(counterpartyId: number, from: string, to: string): Statement {
  const opening = openingBalance(counterpartyId, from);
  const lines = turnover(counterpartyId, from, to);
  const accrued = lines.reduce((sum, l) => sum + l.accrued, 0);
  const paid = lines.reduce((sum, l) => sum + l.paid, 0);
  const unapproved = unapprovedInRange(counterpartyId, from, to);
  const excluded = excludedInRange(counterpartyId, from, to);
  const excludedPaid = excludedPaidInRange(counterpartyId, from, to);

  return {
    counterpartyId,
    from,
    to,
    opening,
    accrued,
    paid,
    closing: opening + accrued - paid,
    unapproved: unapproved.amount,
    unapprovedCount: unapproved.count,
    unallocated: unallocatedFor(counterpartyId, from, to),
    excluded: excluded.amount,
    excludedCount: excluded.count,
    excludedPaid: excludedPaid.amount,
    excludedPaidCount: excludedPaid.count,
    duplicates: duplicatePairs(counterpartyId, from, to),
    lines,
  };
}

/**
 * Правило отбора одной строкой. Печатается в акте, который уходит контрагенту:
 * несовпадение чаще всего объясняется именно базой расчёта, и она должна быть
 * названа в документе, а не подразумеваться.
 */
export const BASIS_TEXT =
  'В расчёт включены все документы, кроме отклонённых, и оплаты по ним. ' +
  'Счёт, закрытый актом или накладной, начислен один раз — по закрывающему документу, ' +
  'а оплата отнесена к самому счёту. ' +
  'Начисления отнесены к дате документа, оплаты — к дате платежа.';
