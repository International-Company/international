import type { Metadata } from 'next';
import { CheckCircle2, Clock, ShieldX, XCircle } from 'lucide-react';
import { prisma } from '@/core/db/prisma';
import { toDecimalString } from '@/core/money/money';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { readToken } from '@/modules/exchange/receipt-verify';
import { Card, CardBody, PageHeader } from '@/ui/primitives';
import { cn } from '@/ui/utils';

export const metadata: Metadata = { title: 'Receipt check', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Where a receipt's QR leads: what the books hold for it, to be read against
 * the paper in someone's hand.
 *
 * For staff only, signed in. The verdict comes first and large — genuine,
 * cancelled, or not ours — because the person holding the phone usually has a
 * customer in front of them and needs the answer before the detail.
 */
export default async function VerifyReceiptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await requirePageAnyPermission('exchange.transaction.view', 'exchange.receipt.print');
  const { token } = await params;
  const { t, locale, ln } = await getTranslator();

  const reference = readToken(decodeURIComponent(token));
  const transaction = reference
    ? await prisma.transaction.findUnique({
        where: { reference },
        include: {
          customer: { select: { fullNameEn: true, fullNameAr: true } },
          createdBy: { select: { fullNameEn: true, fullNameAr: true } },
          branch: { select: { nameEn: true, nameAr: true } },
          receipts: { orderBy: { createdAt: 'asc' }, take: 1 },
          reversedBy: { select: { reference: true } },
        },
      })
    : null;

  const verdict = !reference
    ? { tone: 'bad', icon: ShieldX, title: t('verify.invalid'), hint: t('verify.invalidHint') }
    : !transaction
      ? { tone: 'bad', icon: XCircle, title: t('verify.notFound'), hint: null }
      : transaction.status === 'REVERSED' || transaction.reversedBy
        ? {
            tone: 'bad',
            icon: XCircle,
            title: t('verify.reversed'),
            hint: t('verify.reversedHint'),
          }
        : transaction.status === 'PENDING_TRANSFER'
          ? { tone: 'warn', icon: Clock, title: t('verify.pending'), hint: null }
          : { tone: 'ok', icon: CheckCircle2, title: t('verify.genuine'), hint: null };
  const Icon = verdict.icon;

  const rows: [string, string][] = transaction
    ? [
        [t('receipt.number'), transaction.receipts[0]?.number ?? transaction.reference],
        [t('receipt.date'), formatDateTime(transaction.createdAt, locale)],
        [t('common.branch'), ln(transaction.branch, 'name')],
        [t('receipt.teller'), ln(transaction.createdBy, 'fullName')],
        ...(transaction.customer || transaction.counterpartyName
          ? ([
              [
                t('receipt.customer'),
                transaction.customer
                  ? ln(transaction.customer, 'fullName')
                  : (transaction.counterpartyName ?? ''),
              ],
            ] as [string, string][])
          : []),
        [
          t('receipt.received'),
          `${toDecimalString(transaction.fromAmount, 2)} ${transaction.fromCurrency}`,
        ],
        ...(transaction.fromCurrency !== transaction.toCurrency
          ? ([
              [
                t('receipt.rate'),
                `1 ${transaction.fromCurrency} = ${toDecimalString(transaction.rate, 4)} ${transaction.toCurrency}`,
              ],
              [
                t('receipt.delivered'),
                `${toDecimalString(transaction.toAmount, 2)} ${transaction.toCurrency}`,
              ],
            ] as [string, string][])
          : []),
      ]
    : [];

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader
        title={t('verify.title')}
        description={transaction ? t('verify.hint') : undefined}
      />

      <div
        className={cn(
          'flex items-start gap-3 rounded-2xl p-4 ring-2',
          verdict.tone === 'ok' && 'bg-success-subtle text-success-text ring-success-border',
          verdict.tone === 'warn' && 'bg-warning-subtle text-warning-text ring-warning-border',
          verdict.tone === 'bad' && 'bg-danger-subtle text-danger-text ring-danger-border',
        )}
      >
        <Icon className="mt-0.5 size-7 shrink-0" />
        <div>
          <p className="text-lg font-bold">{verdict.title}</p>
          {verdict.hint && <p className="text-sm">{verdict.hint}</p>}
          {transaction?.reversedBy && (
            <p className="mt-1 text-sm">
              {t('verify.reversalRef', { reference: transaction.reversedBy.reference })}
            </p>
          )}
        </div>
      </div>

      {transaction && (
        <Card>
          <CardBody>
            <p className="mb-2 font-semibold">
              {t(`transactions.type.${transaction.type}` as never)}
            </p>
            <dl className="divide-y divide-border-subtle text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-2">
                  <dt className="text-content-secondary">{label}</dt>
                  <dd className="text-end font-semibold tabular-nums" dir="auto">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {transaction.receipts[0] && (
              <p className="mt-3 text-xs text-content-tertiary">
                {t('verify.printed', { count: transaction.receipts[0].printedCount })}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
