'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Mic,
  NotebookPen,
  Receipt,
  ShieldCheck,
  Trash2,
  UserPlus,
  Video,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Button, Skeleton } from '@/ui/primitives';
import { Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { Avatar } from './chat-ui';

interface Profile {
  phone: string | null;
  group: boolean;
  since: string;
  customer: {
    id: string;
    code: string;
    fullNameAr: string;
    fullNameEn: string;
    phone: string | null;
    city: string | null;
    kycStatus: string;
    riskLevel: string;
    isBlocked: boolean;
    blockReason: string | null;
    notes: string | null;
    createdAt: string;
  } | null;
  transactions: {
    id: string;
    reference: string;
    type: string;
    status: string;
    fromCurrency: string;
    fromAmount: string;
    toCurrency: string;
    toAmount: string;
    createdAt: string;
  }[];
  dealCount: number;
  firstDealAt: string | null;
  notes: { id: string; text: string; authorName: string; mine: boolean; createdAt: string }[];
}

interface Media {
  id: string;
  imageId?: string | null;
  mediaKind?: string | null;
  text: string;
  createdAt: string;
}

/**
 * Who the conversation is with, beside it: the office's record for the
 * number, their last dealings, the photos and files of the conversation, and
 * notes the staff keep on them — never sent.
 */
export function CustomerPanel({
  scope,
  chatId,
  name,
  phone,
  group,
  media,
  onOpenPhoto,
  onClose,
}: {
  scope: 'bot' | 'teller';
  chatId: string;
  name: string | null;
  phone: string | null;
  group?: boolean;
  media: Media[];
  onOpenPhoto: (src: string) => void;
  onClose: () => void;
}) {
  const { t, ln } = useLocale();
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'photos' | 'files'>('photos');

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  useEffect(() => {
    setProfile(null);
    void api
      .get<Profile>(`/api/inbox/profile?scope=${scope}&chatId=${encodeURIComponent(chatId)}`)
      .then(setProfile)
      .catch(failure);
  }, [scope, chatId, failure]);

  const addNote = async () => {
    if (!note.trim() || saving) return;
    setSaving(true);
    try {
      setProfile(await api.post<Profile>('/api/inbox/profile', { scope, chatId, text: note }));
      setNote('');
    } catch (cause) {
      failure(cause);
    } finally {
      setSaving(false);
    }
  };
  const removeNote = async (noteId: string) => {
    try {
      setProfile(
        await api.delete<Profile>(
          `/api/inbox/profile?scope=${scope}&chatId=${encodeURIComponent(chatId)}&noteId=${encodeURIComponent(noteId)}`,
        ),
      );
    } catch (cause) {
      failure(cause);
    }
  };

  const photos = media.filter((entry) => entry.imageId && (entry.mediaKind ?? 'image') === 'image');
  const files = media.filter((entry) => entry.imageId && entry.mediaKind && entry.mediaKind !== 'image');
  const shownPhone = phone ? `+${phone}` : null;
  const section = 'rounded-2xl bg-surface p-3 ring-1 ring-border-subtle';
  const heading = 'mb-2 flex items-center gap-1.5 text-xs font-bold text-content-tertiary';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="inline-flex size-9 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken"
        >
          <X className="size-5" />
        </button>
        <p className="text-sm font-semibold text-content">{t('inbox.profile.title')}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-sunken p-3">
        {/* Who: as WhatsApp's contact page opens, the face and the number. */}
        <div className={`${section} flex flex-col items-center gap-2 py-5 text-center`}>
          <span className="scale-150 py-3">
            <Avatar name={name} phone={phone} group={group} />
          </span>
          <p className="text-lg font-bold text-content">{name ?? shownPhone ?? '—'}</p>
          {shownPhone && (
            <p className="flex items-center gap-1.5 text-sm text-content-secondary">
              <span className="ltr-content tabular-nums">{shownPhone}</span>
              <button
                type="button"
                aria-label={t('inbox.copy')}
                onClick={() => {
                  void navigator.clipboard?.writeText(shownPhone);
                  toast.success(t('inbox.copied'));
                }}
                className="inline-flex size-7 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
              >
                <Copy className="size-3.5" />
              </button>
              <a
                href={`https://wa.me/${phone}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('inbox.openWhatsapp')}
                className="inline-flex size-7 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </p>
          )}
          {profile && (
            <p className="text-[11px] text-content-tertiary">
              {t('inbox.profile.since')} <DateText value={profile.since} />
            </p>
          )}
        </div>

        {!profile ? (
          <Skeleton className="h-48 w-full rounded-2xl" />
        ) : (
          <>
            {/* The office's record for the number. */}
            {!profile.group && (
              <div className={section}>
                <p className={heading}>
                  <ShieldCheck className="size-3.5" />
                  {t('inbox.profile.record')}
                </p>
                {profile.customer ? (
                  <div className="space-y-1.5 text-sm">
                    {profile.customer.isBlocked && (
                      <p className="flex items-start gap-1.5 rounded-lg bg-danger-subtle px-2 py-1.5 text-xs font-semibold text-danger-text">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        {t('inbox.profile.blocked')}
                        {profile.customer.blockReason ? ` — ${profile.customer.blockReason}` : ''}
                      </p>
                    )}
                    <p className="font-semibold text-content">{ln(profile.customer, 'fullName')}</p>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-content-tertiary">{t('inbox.profile.code')}</dt>
                      <dd className="ltr-content font-mono text-content">{profile.customer.code}</dd>
                      {profile.customer.city && (
                        <>
                          <dt className="text-content-tertiary">{t('inbox.profile.city')}</dt>
                          <dd className="text-content">{profile.customer.city}</dd>
                        </>
                      )}
                      <dt className="text-content-tertiary">{t('inbox.profile.kyc')}</dt>
                      <dd className="text-content">{t(`customers.kycStatus.${profile.customer.kycStatus as 'VERIFIED'}`)}</dd>
                      <dt className="text-content-tertiary">{t('inbox.profile.risk')}</dt>
                      <dd className={profile.customer.riskLevel === 'HIGH' ? 'font-semibold text-danger-text' : 'text-content'}>
                        {t(`customers.risk.${profile.customer.riskLevel as 'LOW'}`)}
                      </dd>
                    </dl>
                    {profile.customer.notes && (
                      <p className="whitespace-pre-wrap rounded-lg bg-surface-sunken px-2 py-1.5 text-xs text-content-secondary">
                        {profile.customer.notes}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-content-tertiary">
                    <UserPlus className="size-3.5" />
                    {t('inbox.profile.noRecord')}
                  </p>
                )}
              </div>
            )}

            {/* What they did with the office lately. */}
            {!profile.group && (
              <div className={section}>
                <p className={heading}>
                  <Receipt className="size-3.5" />
                  {t('inbox.profile.deals')}
                  {profile.dealCount > 0 && (
                    <span className="ms-auto font-semibold text-content-secondary tabular-nums">{profile.dealCount}</span>
                  )}
                </p>
                {profile.transactions.length === 0 ? (
                  <p className="text-xs text-content-tertiary">{t('inbox.profile.noDeals')}</p>
                ) : (
                  <ul className="-mx-1 divide-y divide-border-subtle">
                    {profile.transactions.map((deal) => (
                      <li key={deal.id}>
                        <Link
                          href={`/manage/transactions/${deal.id}`}
                          className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-surface-sunken"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="ltr-content flex flex-wrap items-baseline gap-x-1 text-xs font-semibold tabular-nums text-content">
                              <Money value={deal.fromAmount} currency={deal.fromCurrency} />
                              <span className="text-content-tertiary">→</span>
                              <Money value={deal.toAmount} currency={deal.toCurrency} />
                            </span>
                            <span className="flex items-center gap-1.5 text-[11px] text-content-tertiary">
                              <DateText value={deal.createdAt} />
                              <span className="ltr-content font-mono">{deal.reference}</span>
                            </span>
                          </span>
                          {deal.status !== 'POSTED' && (
                            <span className="shrink-0 rounded bg-warning-subtle px-1.5 py-px text-[10px] font-semibold text-warning-text">
                              {deal.status === 'PENDING_TRANSFER'
                                ? t('machine.pendingTransfer')
                                : deal.status === 'REVERSED'
                                  ? t('machine.deletedBadge')
                                  : deal.status}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* The staff's notes: kept here, never sent. */}
            <div className={section}>
              <p className={heading}>
                <NotebookPen className="size-3.5" />
                {t('inbox.profile.notes')}
              </p>
              <div className="space-y-2">
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void addNote();
                  }}
                  placeholder={t('inbox.profile.notePlaceholder')}
                  rows={2}
                  maxLength={1000}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-content-tertiary">{t('inbox.profile.noteHint')}</span>
                  <Button size="sm" loading={saving} disabled={!note.trim()} onClick={() => void addNote()}>
                    {t('inbox.profile.noteAdd')}
                  </Button>
                </div>
                {profile.notes.map((entry) => (
                  <div key={entry.id} className="rounded-lg border-s-4 border-warning bg-warning-subtle/40 px-2.5 py-1.5">
                    <p className="whitespace-pre-wrap text-sm text-content">{entry.text}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-content-tertiary">
                      <span className="font-semibold">{entry.authorName}</span>·
                      <DateText value={entry.createdAt} withTime />
                      {entry.mine && (
                        <button
                          type="button"
                          aria-label={t('inbox.delete')}
                          onClick={() => void removeNote(entry.id)}
                          className="ms-auto inline-flex size-6 items-center justify-center rounded-full hover:bg-surface hover:text-danger-text"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* The photos and files of the conversation, as WhatsApp's media page keeps them. */}
        <div className={section}>
          <div className="mb-2 flex items-center gap-1">
            {(['photos', 'files'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={tab === entry}
                onClick={() => setTab(entry)}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  tab === entry ? 'bg-primary-subtle text-primary-text' : 'text-content-tertiary hover:bg-surface-sunken'
                }`}
              >
                {entry === 'photos' ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
                {t(`inbox.profile.${entry}`)}
                <span className="tabular-nums opacity-70">{entry === 'photos' ? photos.length : files.length}</span>
              </button>
            ))}
          </div>
          {tab === 'photos' ? (
            photos.length === 0 ? (
              <p className="text-xs text-content-tertiary">{t('inbox.profile.noPhotos')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {[...photos].reverse().map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onOpenPhoto(`/api/inbox/images/${entry.imageId}`)}
                    className="aspect-square overflow-hidden rounded-md bg-surface-sunken"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/inbox/images/${entry.imageId}`} alt="" loading="lazy" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            )
          ) : files.length === 0 ? (
            <p className="text-xs text-content-tertiary">{t('inbox.profile.noFiles')}</p>
          ) : (
            <ul className="space-y-1">
              {[...files].reverse().map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`/api/inbox/images/${entry.imageId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-sunken"
                  >
                    {entry.mediaKind === 'audio' ? (
                      <Mic className="size-4 shrink-0 text-content-tertiary" />
                    ) : entry.mediaKind === 'video' ? (
                      <Video className="size-4 shrink-0 text-content-tertiary" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-content-tertiary" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-content">
                      {entry.text || t(`inbox.kind.${entry.mediaKind as 'audio' | 'video' | 'document'}`)}
                    </span>
                    <span className="shrink-0 text-[11px] text-content-tertiary">
                      <DateText value={entry.createdAt} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
