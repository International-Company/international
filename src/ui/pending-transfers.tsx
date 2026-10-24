'use client';

import { useState } from 'react';
import { Copy, MessageCircle, Send } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';

/**
 * Every transfer still owed, as one WhatsApp message.
 *
 * ## Why it shows the message before sending it
 *
 * This goes to the person who moves the money, and he acts on it line by line.
 * Showing it first is how the teller catches a wrong account before it becomes
 * a transfer to the wrong person — which no later message can undo.
 *
 * ## Why WhatsApp with no number
 *
 * The person who makes the transfers is different from office to office and
 * sometimes a group. Opening WhatsApp with the text and letting the teller pick
 * the chat is right for all of them; a stored number would be right for one.
 */
export function PendingTransfersButton({
  size = 'sm',
  variant = 'secondary',
  kind,
}: {
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
  /** Only the machine's exchanges, or only USDT deals — they are settled apart. */
  kind?: 'exchange' | 'usdt';
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ count: number; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.get<{ count: number; text: string }>(
        `/api/transactions/pending-transfers?locale=${locale}${kind ? `&kind=${kind}` : ''}`,
      );
      if (result.count === 0) toast.success(t('share.pendingNone'));
      else setMessage(result);
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success(t('share.copied'));
    } catch {
      toast.error(t('share.copyFailedTitle'), t('share.copyFailedBody'));
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon={<Send />}
        loading={loading}
        onClick={() => void load()}
      >
        {t('share.pending')}
      </Button>

      <Dialog
        open={message !== null}
        onClose={() => setMessage(null)}
        title={message ? t('share.pendingTitle', { count: message.count }) : ''}
        description={t('share.pendingHint')}
        footer={
          <>
            <Button variant="secondary" icon={<Copy />} onClick={() => void copy()}>
              {t('share.copy')}
            </Button>
            <Button
              icon={<MessageCircle />}
              onClick={() => {
                if (!message) return;
                window.open(
                  `https://wa.me/?text=${encodeURIComponent(message.text)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              }}
            >
              {t('share.whatsapp')}
            </Button>
          </>
        }
      >
        {message && (
          <pre
            dir="auto"
            className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-control)] bg-surface-sunken p-3 font-sans text-sm leading-6 text-content"
          >
            {message.text}
          </pre>
        )}
      </Dialog>
    </>
  );
}
