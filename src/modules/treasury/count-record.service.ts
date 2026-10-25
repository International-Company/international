import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as drawers from '@/modules/drawers/drawer.service';

/**
 * محضر الجرد — what a handover back to the treasury found, currency by currency.
 *
 * ## Three figures, not two
 *
 * The handover itself compares what the teller declared with what was counted;
 * a disagreement there is a dispute and moves nothing. The close compares the
 * books with the count, and any gap is booked to the differences balance. A
 * record that showed only one of those comparisons would hide the other, so
 * this shows all three side by side: what the books say he held, what he said
 * he was handing back, and what was counted.
 *
 * ## Where "the books" comes from
 *
 * While the handover waits, it is the teller's drawer as it stands — what he is
 * about to be counted against. Once confirmed, the drawer has been emptied, so
 * it is rebuilt from what the close itself wrote down: counted plus the gap it
 * booked for that currency. Nothing is stored twice and nothing is guessed.
 *
 * Read-only. Nothing here moves money; the handover and the shift still do all
 * of that, exactly as before.
 */

export interface Actor {
  id: string;
  permissions: string[];
}

export interface CountLine {
  currency: string;
  kind: string;
  nature: string;
  /** What the books say the teller held. Null when it cannot be known. */
  expected: bigint | null;
  /** What the teller said he was handing back. */
  declared: bigint;
  /** What was counted. Null until the count. */
  counted: bigint | null;
  /** Books minus counted: positive is a shortage, negative a surplus. */
  difference: bigint | null;
}

/**
 * The books' figure for each line of handovers still waiting to be counted —
 * so the person counting sees what the teller should hold, not only what he
 * says he holds.
 */
export async function expectedForPending(
  handovers: {
    id: string;
    direction: string;
    status: string;
    tellerId: string;
    lines: { currencyCode: string; kind: string }[];
  }[],
  db: DbClient = prisma,
): Promise<Map<string, bigint>> {
  const pending = handovers.filter(
    (handover) =>
      handover.direction === 'TO_TREASURY' &&
      (handover.status === 'PENDING' || handover.status === 'DISPUTED'),
  );
  if (pending.length === 0) return new Map();

  const owners = [...new Set(pending.map((handover) => drawers.tellerOwner(handover.tellerId)))];
  const rows = await db.drawer.findMany({
    where: { ownerKey: { in: owners } },
    select: { ownerKey: true, currencyCode: true, kind: true, balance: true },
  });
  const balance = new Map(
    rows.map((row) => [`${row.ownerKey}:${row.currencyCode}:${row.kind}`, row.balance]),
  );

  const expected = new Map<string, bigint>();
  for (const handover of pending) {
    for (const line of handover.lines) {
      const key = `${drawers.tellerOwner(handover.tellerId)}:${line.currencyCode}:${line.kind}`;
      expected.set(`${handover.id}:${line.currencyCode}:${line.kind}`, balance.get(key) ?? 0n);
    }
  }
  return expected;
}

/** The whole record of one handover's count. */
export async function countRecord(id: string, actor: Actor, db: DbClient = prisma) {
  const handover = await db.handover.findUnique({
    where: { id },
    include: {
      lines: true,
      teller: { select: { id: true, fullNameEn: true, fullNameAr: true } },
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      confirmedBy: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
  if (!handover) throw errors.notFound('Handover', id);

  // The teller it is about, or someone who counts handovers.
  const mayRead =
    handover.tellerId === actor.id || actor.permissions.includes('treasury.handover.manage');
  if (!mayRead) throw errors.forbidden('treasury.handover.manage');

  const confirmed = handover.status === 'CONFIRMED';

  // After the close: the gap it booked, per currency, rebuilds the books' figure.
  const shift = confirmed
    ? await db.shift.findFirst({
        where: { closingHandoverId: handover.id },
        select: {
          reference: true,
          discrepancies: { select: { currencyCode: true, amount: true } },
        },
      })
    : null;
  const gaps = new Map<string, bigint>();
  for (const gap of shift?.discrepancies ?? []) {
    gaps.set(gap.currencyCode, (gaps.get(gap.currencyCode) ?? 0n) + gap.amount);
  }

  // Before it: the drawer as it stands.
  const live = confirmed
    ? new Map<string, bigint>()
    : await expectedForPending(
        [
          {
            id: handover.id,
            direction: handover.direction,
            status: handover.status,
            tellerId: handover.tellerId,
            lines: handover.lines,
          },
        ],
        db,
      );

  const lines: CountLine[] = handover.lines.map((line) => {
    const counted = line.countedAmount;
    const expected =
      handover.direction !== 'TO_TREASURY'
        ? null
        : confirmed
          ? (counted ?? line.amount) + (gaps.get(line.currencyCode) ?? 0n)
          : (live.get(`${handover.id}:${line.currencyCode}:${line.kind}`) ?? null);
    return {
      currency: line.currencyCode,
      kind: line.kind,
      nature: line.nature,
      expected,
      declared: line.amount,
      counted,
      difference: expected !== null && counted !== null ? expected - counted : null,
    };
  });

  return {
    id: handover.id,
    reference: handover.reference,
    direction: handover.direction,
    status: handover.status,
    shift: shift?.reference ?? null,
    teller: handover.teller,
    createdBy: handover.createdBy,
    confirmedBy: handover.confirmedBy,
    createdAt: handover.createdAt,
    confirmedAt: handover.confirmedAt,
    lines,
  };
}
