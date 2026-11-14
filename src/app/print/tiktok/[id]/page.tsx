import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import { formatDateTime } from '@/i18n/format';
import { BRAND } from '@/app/_shell/brand';
import { QrCode } from '@/core/qr/qr-code';
import { receiptQrText, receiptWhatsappLink } from '@/modules/exchange/receipt-qr';
import { forReceipt } from '@/modules/tiktok/tiktok.service';
import { rateText } from '@/modules/tiktok/tiktok-message';
import { AutoPrint } from '../../receipt/[id]/auto-print';

export const metadata: Metadata = { title: 'TikTok receipt', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The receipt of a TikTok withdrawal: the dollars withdrawn, the price, and the
 * shekels sent to the beneficiary's account. On the same paper, in the same
 * number of copies and with the same header as a deal's receipt, so the counter
 * prints both the same way.
 */
export default async function TiktokReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('exchange.receipt.print', 'exchange.remittance.use');
  const { t, locale, ln, isRtl } = await getTranslator();

  const withdrawal = await forReceipt(id, {
    id: session.user.id,
    name: session.user.fullNameEn,
    sessionId: session.sessionId,
    permissions: session.user.permissions,
  });
  if (!withdrawal) notFound();

  const [companyName, licenseNumber, phone, address, copies, paper, bankNote, whatsapp] =
    await Promise.all([
      settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
      settings.getString('company.licenseNumber'),
      settings.getString('company.phone'),
      settings.getString('company.address'),
      settings.getNumber('operations.receiptCopies'),
      settings.getString('operations.receiptPaper'),
      settings.getString('operations.bankReceiptNote'),
      settings.getString('operations.receiptWhatsapp'),
    ]);

  // The same roll as a deal's receipt: see the note there.
  const roll = paper === 'POS58' ? 48 : paper === 'POS80' ? 72 : null;
  const muted = roll ? 'text-black' : 'text-gray-600';
  const rule = roll ? 'border-dashed border-black' : 'border-gray-300';

  const whatsappLink = receiptWhatsappLink(whatsapp, withdrawal.number);
  const qrText =
    whatsappLink ??
    receiptQrText({
      company: companyName,
      number: withdrawal.number,
      when: formatDateTime(withdrawal.createdAt, locale),
      paid: { amount: withdrawal.amount, currency: withdrawal.currency },
      received: { amount: withdrawal.payoutAmount, currency: 'ILS' },
    });
  const copyLabels = [t('receipt.originalCopy'), t('receipt.officeCopy')];
  const total = Math.max(1, Math.min(copies, 3));

  return (
    <div className="min-h-screen bg-canvas p-4 print:min-h-0 print:bg-white print:p-0">
      <AutoPrint />
      {roll && (
        <style>{`@media print { @page { size: ${roll === 48 ? 58 : 80}mm 3276mm; margin: 0; } }`}</style>
      )}

      <div
        className={roll ? 'mx-auto space-y-6 print:space-y-0' : 'mx-auto max-w-md space-y-6'}
        style={roll ? { width: `${roll}mm` } : undefined}
      >
        {Array.from({ length: total }, (_, index) => (
          <article
            key={index}
            data-receipt
            dir={isRtl ? 'rtl' : 'ltr'}
            className={[
              roll
                ? 'bg-white px-1 pb-1 text-[11px] font-medium leading-tight text-black'
                : 'bg-white text-black border border-gray-300 p-6 text-[13px] leading-relaxed',
              index < total - 1 ? 'print-break' : '',
            ].join(' ')}
          >
            <header
              className={`border-b text-center ${roll ? 'border-dashed border-black pb-1.5' : 'border-gray-400 pb-3'}`}
            >
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
                {t('receipt.tiktokTitle')}
              </p>
              {!roll && (
                <p className={`text-xs ${muted}`}>
                  {copyLabels[index] ?? t('receipt.copy', { index: index + 1, total })}
                </p>
              )}
            </header>

            <dl
              className={`border-b text-xs ${rule} ${roll ? 'mt-1.5 space-y-0.5 pb-1.5 text-[11px]' : 'mt-3 space-y-1 pb-3'}`}
            >
              <Row label={t('receipt.number')} value={withdrawal.number} mono muted={muted} />
              <Row
                label={t('receipt.date')}
                value={formatDateTime(withdrawal.createdAt, locale)}
                muted={muted}
              />
              <Row
                label={t('receipt.teller')}
                value={ln(withdrawal.createdBy, 'fullName')}
                muted={muted}
              />
              <Row
                label={t('receipt.customer')}
                value={withdrawal.beneficiaryName.trim()}
                muted={muted}
              />
            </dl>

            <div className={roll ? 'mt-1.5 space-y-1' : 'mt-3 space-y-2'}>
              <table className={`w-full ${roll ? 'text-[12px] [&_td]:py-0.5' : 'text-sm'}`}>
                <tbody>
                  <tr>
                    <td className="py-1">{t('receipt.withdrawn')}</td>
                    <td className="py-1 text-end font-semibold" dir="ltr">
                      {toDecimalString(withdrawal.amount, 2)} {withdrawal.currency}
                    </td>
                  </tr>
                  {withdrawal.rate > 0n && (
                    <tr>
                      <td className="py-1">{t('receipt.rate')}</td>
                      <td className="py-1 text-end" dir="ltr">
                        1 {withdrawal.currency} = {rateText(withdrawal.rate)} ILS
                      </td>
                    </tr>
                  )}
                  {withdrawal.payoutAmount > 0n && (
                    <tr className={`border-t ${rule}`}>
                      <td className="py-1 font-semibold">{t('receipt.transferred')}</td>
                      <td className="py-1 text-end font-bold" dir="ltr">
                        {toDecimalString(withdrawal.payoutAmount, 2)} ILS
                      </td>
                    </tr>
                  )}
                  {withdrawal.channel && (
                    <tr className={`border-t ${rule}`}>
                      <td className="py-1">{t('receipt.payoutChannel')}</td>
                      <td className="py-1 text-end font-semibold">{withdrawal.channel}</td>
                    </tr>
                  )}
                  {withdrawal.account && (
                    <tr>
                      <td className="py-1">{t('receipt.payoutAccount')}</td>
                      <td className="py-1 text-end font-mono font-semibold" dir="ltr">
                        {withdrawal.account}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {bankNote.trim() && (
              <p
                className={`border-y text-center font-semibold ${rule} ${roll ? 'mt-2 py-1 text-[11px]' : 'mt-3 py-2 text-xs'}`}
              >
                {bankNote}
              </p>
            )}

            <div className={`flex flex-col items-center ${roll ? 'mt-2' : 'mt-4'}`}>
              <QrCode
                value={qrText}
                level="M"
                size={roll ? 128 : 130}
                title={whatsappLink ? t('receipt.qrWhatsapp') : t('receipt.qrTitle')}
              />
              {whatsappLink && (
                <p
                  className={`text-center font-semibold ${roll ? 'mt-1 text-[11px]' : 'mt-1 text-xs'}`}
                >
                  {t('receipt.qrWhatsapp')}
                </p>
              )}
            </div>

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
