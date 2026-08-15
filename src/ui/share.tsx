'use client';

import { useCallback, useState } from 'react';
import { Copy, MessageCircle, Send, Share2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { DropdownMenu, MenuItem, useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';

/**
 * Sending a transaction to somebody.
 *
 * ## Why a menu and not one button
 *
 * The obvious design is a single button calling `navigator.share`, and on a
 * phone that is the right behaviour — the operating system's own sheet, with
 * every application the teller already has. But half this office works at a
 * desk, and on a desktop browser that call either does not exist or opens a
 * sheet with nothing useful in it. A control that behaves like the point of the
 * feature on one machine and like a dead end on the next is not one control.
 *
 * So: the sheet when the machine has one, WhatsApp always, and the text on the
 * clipboard for everything else. Three doors, all of them open.
 *
 * ## Why WhatsApp is named explicitly
 *
 * Because that is what the office uses, and because of what it lets a person do
 * that no API can. Sending to a *group* — the branch group, the correspondent's
 * group — is not something WhatsApp's business API offers at any price. Handing
 * the message to the application and letting the teller pick the chat does it
 * in one tap, and it is the only thing that does.
 *
 * ## Why the text is fetched before it is needed
 *
 * A native share sheet must open inside the click that asked for it. Fetching
 * the message first and sharing second would spend the gesture on the network,
 * and some browsers then refuse to open the sheet at all. So the message is
 * fetched when the menu opens — a moment earlier, while the teller is still
 * reading the three options — and the click itself does nothing but share.
 */

interface Shareable {
  reference: string;
  text: string;
  phone: string | null;
}

/** Digits only, with the leading zero of a local number dropped. */
function wa(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

export function ShareButton({
  transactionId,
  compact = false,
  size = 'sm',
  variant = 'ghost',
}: {
  transactionId: string;
  /** An icon in a list, rather than a labelled button under a result. */
  compact?: boolean;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}) {
  const { t, locale } = useLocale();
  const toast = useToast();

  const [payload, setPayload] = useState<Shareable | null>(null);
  const [loading, setLoading] = useState(false);

  /** Asked for once per open, and kept — the text of a posting cannot change. */
  const load = useCallback(async () => {
    if (payload || loading) return;
    setLoading(true);
    try {
      setPayload(
        await api.get<Shareable>(`/api/transactions/${transactionId}/share?locale=${locale}`),
      );
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setLoading(false);
    }
  }, [payload, loading, transactionId, locale, t, toast]);

  /*
   * Recorded after the act and never in front of it: a share that failed, or
   * one the teller abandoned in the system's own sheet, did not happen and must
   * not appear in the log as though it had. Failing to write the line does not
   * fail the share — the message is already gone.
   */
  const note = (channel: 'SYSTEM' | 'WHATSAPP' | 'COPY') => {
    void api.post(`/api/transactions/${transactionId}/share`, { channel }).catch(() => {});
  };

  const viaSystem = async (data: Shareable) => {
    try {
      await navigator.share({ title: data.reference, text: data.text });
      note('SYSTEM');
    } catch {
      // Dismissing the sheet is a decision, not a failure. Nothing to say.
    }
  };

  const viaWhatsApp = (data: Shareable, toCustomer: boolean) => {
    const number = toCustomer && data.phone ? wa(data.phone) : '';
    window.open(
      `https://wa.me/${number}?text=${encodeURIComponent(data.text)}`,
      '_blank',
      'noopener,noreferrer',
    );
    note('WHATSAPP');
  };

  const viaClipboard = async (data: Shareable) => {
    try {
      await navigator.clipboard.writeText(data.text);
      toast.success(t('share.copied'), data.reference);
      note('COPY');
    } catch {
      toast.error(t('share.copyFailedTitle'), t('share.copyFailedBody'));
    }
  };

  const label = t('share.action');

  return (
    <DropdownMenu
      trigger={({ onClick, ...rest }) =>
        compact ? (
          <button
            type="button"
            onClick={() => {
              void load();
              onClick();
            }}
            title={label}
            aria-label={label}
            {...rest}
            className={cn(
              'flex size-10 items-center justify-center rounded-full text-content-tertiary sm:size-8',
              'transition-colors hover:bg-surface-sunken hover:text-content',
            )}
          >
            <Share2 className="size-4" />
          </button>
        ) : (
          <Button
            size={size}
            variant={variant}
            icon={<Share2 />}
            onClick={() => {
              void load();
              onClick();
            }}
            {...rest}
          >
            {label}
          </Button>
        )
      }
    >
      {(close) => {
        const act = (run: (data: Shareable) => void | Promise<void>) => () => {
          close();
          if (payload) void run(payload);
        };

        return (
          <>
            {/*
              Only where the machine actually has a sheet. Offering it everywhere
              and having it do nothing on a desktop would teach the teller to
              distrust the whole menu.
            */}
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
              <MenuItem icon={<Share2 />} disabled={!payload} onClick={act(viaSystem)}>
                {t('share.system')}
              </MenuItem>
            )}

            {payload?.phone && (
              <MenuItem
                icon={<Send />}
                disabled={!payload}
                onClick={act((data) => viaWhatsApp(data, true))}
              >
                {t('share.whatsappCustomer')}
              </MenuItem>
            )}

            <MenuItem
              icon={<MessageCircle />}
              disabled={!payload}
              onClick={act((data) => viaWhatsApp(data, false))}
            >
              {t('share.whatsapp')}
            </MenuItem>

            <MenuItem icon={<Copy />} disabled={!payload} onClick={act(viaClipboard)}>
              {t('share.copy')}
            </MenuItem>
          </>
        );
      }}
    </DropdownMenu>
  );
}
