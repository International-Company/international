import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import * as audit from '@/modules/audit/audit.service';
import { destinations } from './remittance.service';
import { validFee, type FeeKind } from './remittance-pricing';
import type { Actor } from './transaction.service';

/**
 * The price list the manager keeps from the remittance screen: one row for each
 * destination and currency.
 */

const MANAGE = 'exchange.rate.manage';

export interface PriceInput {
  destination: string;
  currency: string;
  chargeKind: FeeKind;
  chargeValue: bigint;
  costKind: FeeKind;
  costValue: bigint;
}

const said = (kind: string, value: bigint) =>
  kind === 'PERCENT' ? `${toDecimalString(value, 4)}%` : toDecimalString(value, 2);

export async function savePrice(input: PriceInput, actor: Actor, db: DbClient = prisma) {
  if (!actor.permissions.includes(MANAGE)) throw errors.forbidden(MANAGE);

  const destination = input.destination.trim();
  if (!(await destinations(db)).includes(destination)) {
    throw errors.precondition(
      `${destination} is not a destination the counter offers`,
      'errors.destinationUnknown',
      { destination },
    );
  }
  const currency = await db.currency.findUnique({
    where: { code: input.currency },
    select: { kind: true, isActive: true },
  });
  if (!currency?.isActive || currency.kind !== 'FIAT') {
    throw errors.notFound('Currency', input.currency);
  }
  if (
    !validFee({ kind: input.chargeKind, value: input.chargeValue }) ||
    !validFee({ kind: input.costKind, value: input.costValue })
  ) {
    throw errors.precondition('That fee cannot be used', 'errors.remittancePriceInvalid');
  }

  const data = {
    chargeKind: input.chargeKind,
    chargeValue: input.chargeValue,
    costKind: input.costKind,
    costValue: input.costValue,
    updatedById: actor.id,
  };
  const row = await db.remittancePrice.upsert({
    where: { destination_currency: { destination, currency: input.currency } },
    create: { destination, currency: input.currency, ...data },
    update: data,
  });

  const summary = `${destination} ${input.currency}: ${said(input.chargeKind, input.chargeValue)} / ${said(input.costKind, input.costValue)}`;
  await audit.record(
    {
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'RemittancePrice',
      entityId: row.id,
      summaryEn: `Set the remittance price for ${summary}`,
      summaryAr: `تحديد تسعيرة الحوالة لـ ${summary}`,
      actor,
    },
    db,
  );
  return { id: row.id };
}

export async function deletePrice(id: string, actor: Actor, db: DbClient = prisma) {
  if (!actor.permissions.includes(MANAGE)) throw errors.forbidden(MANAGE);
  const row = await db.remittancePrice.findUnique({ where: { id } });
  if (!row) throw errors.notFound('RemittancePrice', id);
  await db.remittancePrice.delete({ where: { id } });
  await audit.record(
    {
      action: 'DELETE',
      module: 'exchange',
      entityType: 'RemittancePrice',
      entityId: id,
      summaryEn: `Removed the remittance price for ${row.destination} ${row.currency}`,
      summaryAr: `حذف تسعيرة الحوالة لـ ${row.destination} ${row.currency}`,
      actor,
    },
    db,
  );
  return { ok: true };
}
