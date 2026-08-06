import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import { formatDateTime } from '@/i18n/format';
import { AutoPrint } from './auto-print';

export const metadata: Metadata = { title: 'Receipt', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Printable receipt.
 *
 * Rendered as HTML and printed by the browser rather than generated as a PDF
 * server-side. That is a deliberate choice: Arabic requires bidirectional text
 * and contextual letter shaping, which the browser's text engine does correctly
 * and most server-side PDF libraries mangle. It also means the receipt uses the
 * same fonts and translations as the rest of the system.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('exchange.receipt.print');
  const { t, locale, ln, isRtl } = await getTranslator();

  const transaction = await prisma.transaction.findUnique({
    where: { id },
    include: {
      customer: true,
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      branch: true,
      receipts: { orderBy: { createdAt: 'asc' }, take: 1 },
    },
  });

  if (!transaction || transaction.status !== 'POSTED') notFound();

  const [companyName, licenseNumber, phone, address, copies] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
    settings.getString('company.licenseNumber'),
    settings.getString('company.phone'),
    settings.getString('company.address'),
    settings.getNumber('operations.receiptCopies'),
  ]);

  const receipt = transaction.receipts[0];

  // Reprints are recorded — a second copy of a receipt is a real event.
  if (receipt) {
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        printedCount: { increment: 1 },
        lastPrintedAt: new Date(),
        lastPrintedById: session.user.id,
      },
    });

    await audit.record({
      action: 'PRINT',
      module: 'exchange',
      entityType: 'Transaction',
      entityId: transaction.id,
      summaryEn: `Printed receipt ${receipt.number} for ${transaction.reference}`,
      summaryAr: `طباعة الإيصال ${receipt.number} للعملية ${transaction.reference}`,
      actor: { id: session.user.id, name: session.user.fullNameEn, sessionId: session.sessionId },
      metadata: { printedCount: receipt.printedCount + 1 },
    });
  }

  const isExchange = transaction.toCurrency !== transaction.fromCurrency;
  const copyLabels = [t('receipt.originalCopy'), t('receipt.officeCopy')];

  return (
    <div className="min-h-screen bg-canvas p-4 print:bg-white print:p-0">
      <AutoPrint />

      <div className="mx-auto max-w-md space-y-6">
        {Array.from({ length: Math.max(1, Math.min(copies, 3)) }, (_, index) => (
          <article
            key={index}
            dir={isRtl ? 'rtl' : 'ltr'}
            className={[
              'bg-white text-black border border-gray-300 p-6 text-[13px] leading-relaxed',
              index < copies - 1 ? 'print-break' : '',
            ].join(' ')}
          >
            {/* --- Header ------------------------------------------------- */}
            <header className="border-b border-gray-400 pb-3 text-center">
              <h1 className="text-lg font-bold">{companyName}</h1>
              {licenseNumber && (
                <p className="text-xs text-gray-600">
                  {t('receipt.licenseNo')}: {licenseNumber}
                </p>
              )}
              {(phone || address) && (
                <p className="text-xs text-gray-600">{[address, phone].filter(Boolean).join(' · ')}</p>
              )}
              <p className="mt-2 text-sm font-semibold">{t('receipt.title')}</p>
              <p className="text-xs text-gray-600">
                {copyLabels[index] ?? t('receipt.copy', { index: index + 1, total: copies })}
              </p>
            </header>

            {/* --- Meta ---------------------------------------------------- */}
            <dl className="mt-3 space-y-1 border-b border-gray-300 pb-3 text-xs">
              <Row label={t('receipt.number')} value={receipt?.number ?? transaction.reference} mono />
              <Row label={t('transactions.reference')} value={transaction.reference} mono />
              <Row
                label={t('receipt.date')}
                value={formatDateTime(transaction.postedAt ?? transaction.createdAt, locale)}
              />
              <Row label={t('common.branch')} value={ln(transaction.branch, 'name')} />
              <Row label={t('receipt.teller')} value={ln(transaction.createdBy, 'fullName')} />
              {transaction.customer && (
                <Row label={t('receipt.customer')} value={ln(transaction.customer, 'fullName')} />
              )}
              {!transaction.customer && transaction.counterpartyName && (
                <Row label={t('receipt.customer')} value={transaction.counterpartyName} />
              )}
            </dl>

            {/* --- Amounts -------------------------------------------------- */}
            <div className="mt-3 space-y-2">
              <p className="text-sm font-semibold">
                {t(`transactions.type.${transaction.type}` as never)}
              </p>

              <table className="w-full text-sm">
                <tbody>
                  <tr>
                    <td className="py-1">{t('receipt.received')}</td>
                    <td className="py-1 text-end font-semibold" dir="ltr">
                      {toDecimalString(transaction.fromAmount, 2)} {transaction.fromCurrency}
                    </td>
                  </tr>

                  {isExchange && (
                    <>
                      <tr>
                        <td className="py-1">{t('receipt.rate')}</td>
                        <td className="py-1 text-end" dir="ltr">
                          1 {transaction.fromCurrency} = {toDecimalString(transaction.rate, 4)}{' '}
                          {transaction.toCurrency}
                        </td>
                      </tr>
                      <tr className="border-t border-gray-300">
                        <td className="py-1 font-semibold">{t('receipt.delivered')}</td>
                        <td className="py-1 text-end font-bold" dir="ltr">
                          {toDecimalString(transaction.toAmount, 2)} {transaction.toCurrency}
                        </td>
                      </tr>
                    </>
                  )}

                  {transaction.feeAmount > 0n && (
                    <tr>
                      <td className="py-1">{t('receipt.commission')}</td>
                      <td className="py-1 text-end" dir="ltr">
                        {toDecimalString(transaction.feeAmount, 2)}{' '}
                        {transaction.feeCurrency ?? transaction.fromCurrency}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {transaction.notes && (
              <p className="mt-3 border-t border-gray-300 pt-2 text-xs text-gray-700">
                {transaction.notes}
              </p>
            )}

            {/* --- Signatures ------------------------------------------------ */}
            <div className="mt-6 grid grid-cols-2 gap-6 text-xs">
              <div>
                <div className="h-10 border-b border-gray-400" />
                <p className="mt-1 text-center text-gray-600">{t('receipt.signature')}</p>
              </div>
              <div>
                <div className="h-10 border-b border-gray-400" />
                <p className="mt-1 text-center text-gray-600">{t('receipt.tellerSignature')}</p>
              </div>
            </div>

            <footer className="mt-4 border-t border-gray-300 pt-2 text-center text-[10px] text-gray-600">
              <p>{t('receipt.disclaimer')}</p>
              <p className="mt-1 font-semibold">{t('receipt.thankYou')}</p>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-600">{label}</dt>
      <dd className={mono ? 'font-mono' : undefined} dir={mono ? 'ltr' : undefined}>
        {value}
      </dd>
    </div>
  );
}
