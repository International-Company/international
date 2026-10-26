import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import { formatDateTime } from '@/i18n/format';
import { BRAND } from '@/app/_shell/brand';
import { QrCode } from '@/core/qr/qr-code';
import { verificationToken } from '@/modules/exchange/receipt-verify';
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
      payoutWallet: { select: { network: true } },
    },
  });

  /*
   * A transfer still awaiting confirmation prints too.
   *
   * The customer has already paid and is standing at the counter; withholding
   * their receipt until a manager confirms the transfer left would mean nobody
   * gets paper for a bank payout or a USDT sale until later that day. What the
   * receipt must not do is claim more than happened, so the pending state is
   * printed on it.
   */
  if (
    !transaction ||
    (transaction.status !== 'POSTED' && transaction.status !== 'PENDING_TRANSFER')
  ) {
    notFound();
  }

  const [companyName, licenseNumber, phone, address, copies, paper] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
    settings.getString('company.licenseNumber'),
    settings.getString('company.phone'),
    settings.getString('company.address'),
    settings.getNumber('operations.receiptCopies'),
    settings.getString('operations.receiptPaper'),
  ]);

  /*
   * A thermal roll: the printable width of the roll, no margins, and solid
   * black only — a thermal head prints grey as speckle, and a border as a
   * smear down both edges. Each copy ends in a page break, which the printer
   * driver turns into a cut.
   */
  const roll = paper === 'POS58' ? 48 : paper === 'POS80' ? 72 : null;
  const muted = roll ? 'text-black' : 'text-gray-600';
  const rule = roll ? 'border-dashed border-black' : 'border-gray-300';

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

  // Paid out by bank or wallet transfer, in whole or in part.
  const bankPayout = transaction.payoutBankAmount > 0n && !transaction.payoutAddress;
  const payoutNumber =
    transaction.payoutAccount?.trim() ||
    transaction.customer?.phone ||
    transaction.counterpartyPhone ||
    null;

  /*
   * The QR opens this receipt's verification page on whatever address the
   * office reached the system on — read from the request rather than from
   * configuration, so it is right without anybody having to set it.
   */
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? '';
  const proto =
    requestHeaders.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const verifyUrl = `${proto}://${host}/verify/${encodeURIComponent(verificationToken(transaction.reference))}`;
  const copyLabels = [t('receipt.originalCopy'), t('receipt.officeCopy')];

  return (
    <div className="min-h-screen bg-canvas p-4 print:bg-white print:p-0">
      {/* On a roll the page is cut to the receipt's own length, measured once it has rendered. */}
      <AutoPrint rollWidthMm={roll ? roll + 8 : undefined} />
      {roll && <style>{`@media print { @page { size: ${roll + 8}mm auto; margin: 0; } }`}</style>}

      <div
        className={roll ? 'mx-auto space-y-6 print:space-y-0' : 'mx-auto max-w-md space-y-6'}
        style={roll ? { width: `${roll}mm` } : undefined}
      >
        {Array.from({ length: Math.max(1, Math.min(copies, 3)) }, (_, index) => (
          <article
            key={index}
            data-receipt
            dir={isRtl ? 'rtl' : 'ltr'}
            className={[
              roll
                ? 'bg-white px-1 pb-1 text-[11px] font-medium leading-tight text-black'
                : 'bg-white text-black border border-gray-300 p-6 text-[13px] leading-relaxed',
              index < copies - 1 ? 'print-break' : '',
            ].join(' ')}
          >
            {/* --- Header ------------------------------------------------- */}
            <header
              className={`border-b text-center ${roll ? 'border-dashed border-black pb-1.5' : 'border-gray-400 pb-3'}`}
            >
              {/*
                The logo, in grey on a roll: a thermal head has no colour, and a
                colour image left to the driver prints as a dark blot.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={BRAND.logoSmall}
                alt=""
                className={`mx-auto ${roll ? 'mb-1 size-[16mm] grayscale contrast-125' : 'mb-2 size-16'}`}
              />
              <h1 className={roll ? 'text-[14px] font-bold leading-tight' : 'text-lg font-bold'}>
                {companyName}
              </h1>
              {licenseNumber && (
                <p className={`text-xs ${muted}`}>
                  {t('receipt.licenseNo')}: {licenseNumber}
                </p>
              )}
              {(phone || address) && (
                <p className={`text-xs ${muted}`}>{[address, phone].filter(Boolean).join(' · ')}</p>
              )}
              <p className={roll ? 'mt-1 text-[12px] font-semibold' : 'mt-2 text-sm font-semibold'}>
                {t('receipt.title')}
              </p>
              {!roll && (
                <p className={`text-xs ${muted}`}>
                  {copyLabels[index] ?? t('receipt.copy', { index: index + 1, total: copies })}
                </p>
              )}
            </header>

            {/* --- Meta ---------------------------------------------------- */}
            <dl
              className={`border-b text-xs ${rule} ${roll ? 'mt-1.5 space-y-0.5 pb-1.5 text-[11px]' : 'mt-3 space-y-1 pb-3'}`}
            >
              <Row
                label={t('receipt.number')}
                value={receipt?.number ?? transaction.reference}
                mono
                muted={muted}
              />
              {/* Only when it says something the receipt number did not. */}
              {receipt?.number && receipt.number !== transaction.reference && (
                <Row
                  label={t('transactions.reference')}
                  value={transaction.reference}
                  mono
                  muted={muted}
                />
              )}
              <Row
                label={t('receipt.date')}
                value={formatDateTime(transaction.createdAt ?? transaction.createdAt, locale)}
                muted={muted}
              />
              <Row
                label={t('common.branch')}
                value={ln(transaction.branch, 'name')}
                muted={muted}
              />
              <Row
                label={t('receipt.teller')}
                value={ln(transaction.createdBy, 'fullName')}
                muted={muted}
              />
              {transaction.customer && (
                <Row
                  label={t('receipt.customer')}
                  value={ln(transaction.customer, 'fullName')}
                  muted={muted}
                />
              )}
              {!transaction.customer && transaction.counterpartyName && (
                <Row
                  label={t('receipt.customer')}
                  value={transaction.counterpartyName}
                  muted={muted}
                />
              )}
            </dl>

            {/* --- Amounts -------------------------------------------------- */}
            <div className={roll ? 'mt-1.5 space-y-1' : 'mt-3 space-y-2'}>
              <p className={roll ? 'text-[12px] font-semibold' : 'text-sm font-semibold'}>
                {t(`transactions.type.${transaction.type}` as never)}
                {transaction.status === 'PENDING_TRANSFER' && (
                  <span className="ms-2 font-normal">— {t('machine.pendingTransfer')}</span>
                )}
              </p>

              <table className={`w-full ${roll ? 'text-[12px] [&_td]:py-0.5' : 'text-sm'}`}>
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
                      <tr className={`border-t ${rule}`}>
                        <td className="py-1 font-semibold">{t('receipt.delivered')}</td>
                        <td className="py-1 text-end font-bold" dir="ltr">
                          {toDecimalString(transaction.toAmount, 2)} {transaction.toCurrency}
                        </td>
                      </tr>
                    </>
                  )}

                  {/*
                    Where a bank or wallet payout went: the beneficiary's bank or
                    wallet, the account (or the wallet's number), and how much
                    went that way when part of it was paid in cash.
                  */}
                  {bankPayout && (
                    <>
                      <tr className={`border-t ${rule}`}>
                        <td className="py-1">{t('receipt.payoutChannel')}</td>
                        <td className="py-1 text-end font-semibold">
                          {transaction.payoutBankChannel ?? '—'}
                        </td>
                      </tr>
                      {payoutNumber && (
                        <tr>
                          <td className="py-1">{t('receipt.payoutAccount')}</td>
                          <td className="py-1 text-end font-mono font-semibold" dir="ltr">
                            {payoutNumber}
                          </td>
                        </tr>
                      )}
                      {transaction.payoutCashAmount > 0n && (
                        <>
                          <tr>
                            <td className="py-1">{t('receipt.byTransfer')}</td>
                            <td className="py-1 text-end" dir="ltr">
                              {toDecimalString(transaction.payoutBankAmount, 2)}{' '}
                              {transaction.toCurrency}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-1">{t('receipt.inCash')}</td>
                            <td className="py-1 text-end" dir="ltr">
                              {toDecimalString(transaction.payoutCashAmount, 2)}{' '}
                              {transaction.toCurrency}
                            </td>
                          </tr>
                        </>
                      )}
                    </>
                  )}

                  {/*
                    Where the coins went. On the receipt because this is the
                    only copy the customer takes away, and the address is the
                    one part of a withdrawal nobody can correct afterwards —
                    printing it whole is what lets them check it while they are
                    still standing at the counter.
                  */}
                  {transaction.payoutAddress && (
                    <tr className={`border-t ${rule}`}>
                      <td className="py-1 align-top">{t('withdraw.address')}</td>
                      <td className="py-1 text-end align-top" dir="ltr">
                        <span className="break-all font-mono text-xs">
                          {transaction.payoutAddress}
                        </span>
                        {transaction.payoutWallet && (
                          <span className={`block text-xs ${muted}`}>
                            {transaction.payoutWallet.network}
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {transaction.notes && (
              <p
                className={`mt-3 border-t pt-2 text-xs ${rule} ${roll ? 'text-black' : 'text-gray-700'}`}
              >
                {transaction.notes}
              </p>
            )}

            {/* --- Verification: scanned by staff to check this paper against the books --- */}
            <div className={`flex flex-col items-center ${roll ? 'mt-2' : 'mt-4'}`}>
              <QrCode
                value={verifyUrl}
                level="M"
                size={roll ? 96 : 110}
                title={t('receipt.verify')}
              />
            </div>

            {/* --- Signatures — on paper only; a roll receipt is the customer's slip --- */}
            {!roll && (
              <div className="mt-6 grid grid-cols-2 gap-6 text-xs">
                <div>
                  <div className="h-10 border-b border-gray-400" />
                  <p className={`mt-1 text-center ${muted}`}>{t('receipt.signature')}</p>
                </div>
                <div>
                  <div className="h-10 border-b border-gray-400" />
                  <p className={`mt-1 text-center ${muted}`}>{t('receipt.tellerSignature')}</p>
                </div>
              </div>
            )}

            <footer
              className={`border-t text-center ${rule} ${roll ? 'mt-2 pt-1 pb-2 text-[10px] text-black' : 'mt-4 pt-2 text-[10px] text-gray-600'}`}
            >
              <p>{t('receipt.disclaimer')}</p>
              <p className="mt-1 font-semibold">{t('receipt.thankYou')}</p>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  muted = 'text-gray-600',
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: string;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className={muted}>{label}</dt>
      <dd className={mono ? 'font-mono' : undefined} dir={mono ? 'ltr' : undefined}>
        {value}
      </dd>
    </div>
  );
}
