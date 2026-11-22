'use client';

import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Check, MailOpen, Mail, Pencil, Pin, PinOff, Plus, Tag, Trash2, Zap } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { Dialog } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { Checkbox, Input, Textarea } from '@/ui/form';

export interface QuickReply {
  id: string;
  shortcut: string;
  text: string;
  shared: boolean;
  mine: boolean;
}

export interface InboxLabel {
  id: string;
  name: string;
  color: string;
}

export interface ChatMark {
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  markedUnread: boolean;
  labels: string[];
}

export interface Organisation {
  labels: InboxLabel[];
  marks: Record<string, ChatMark>;
}

export const LABEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

/** A reply as it goes to this customer: their name where the reply says {الاسم} or {name}. */
export const fillReply = (text: string, name: string | null) =>
  text.replace(/\{(الاسم|name)\}/gi, name?.trim() || '').replace(/\s{2,}/g, ' ');

/** The replies a "/" typed at the start of the box finds, best first. */
export function matchReplies(replies: QuickReply[], draft: string): QuickReply[] | null {
  if (!draft.startsWith('/') || draft.includes('\n')) return null;
  const typed = draft.slice(1).trim().toLowerCase();
  if (typed.includes(' ') && typed.length > 30) return null;
  const starts = replies.filter((reply) => reply.shortcut.toLowerCase().startsWith(typed));
  const contains = replies.filter(
    (reply) => !starts.includes(reply) && (reply.shortcut.toLowerCase().includes(typed) || reply.text.toLowerCase().includes(typed)),
  );
  return [...starts, ...contains].slice(0, 8);
}

/** Over the box while "/" is typed: the replies found, one press to put in. */
export function ReplyPicker({
  found,
  active,
  onPick,
  onManage,
}: {
  found: QuickReply[];
  active: number;
  onPick: (reply: QuickReply) => void;
  onManage: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
      {found.length === 0 ? (
        <p className="px-4 py-3 text-sm text-content-tertiary">{t('inbox.replies.none')}</p>
      ) : (
        <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
          {found.map((reply, index) => (
            <li key={reply.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(reply)}
                className={`flex w-full items-start gap-3 px-3 py-2 text-start ${index === active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60'}`}
              >
                <span className="ltr-content shrink-0 rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-xs font-semibold text-primary-text">
                  /{reply.shortcut}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-sm text-content-secondary">{reply.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onManage}
        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-xs font-semibold text-primary-text hover:bg-surface-sunken"
      >
        <Zap className="size-3.5" />
        {t('inbox.replies.manage')}
      </button>
    </div>
  );
}

/** The person's quick replies: written, changed, shared with the office, removed. */
export function RepliesDialog({
  open,
  onClose,
  replies,
  canShare,
  onSave,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  replies: QuickReply[];
  canShare: boolean;
  onSave: (reply: { id?: string; shortcut: string; text: string; shared: boolean }) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const { t } = useLocale();
  const empty = { id: undefined as string | undefined, shortcut: '', text: '', shared: false };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setForm(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    setSaving(true);
    const done = await onSave(form);
    setSaving(false);
    if (done) setForm(empty);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('inbox.replies.title')} description={t('inbox.replies.hint')} size="lg">
      <div className="space-y-4">
        <div className="space-y-2 rounded-2xl bg-surface-sunken p-3">
          <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Input
              value={form.shortcut}
              onChange={(event) => setForm({ ...form, shortcut: event.target.value })}
              placeholder={t('inbox.replies.shortcut')}
              dir="ltr"
              className="font-mono"
            />
            <Textarea
              value={form.text}
              onChange={(event) => setForm({ ...form, text: event.target.value })}
              placeholder={t('inbox.replies.text')}
              rows={2}
              maxLength={2000}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canShare ? (
              <Checkbox
                label={t('inbox.replies.shared')}
                checked={form.shared}
                onChange={(event) => setForm({ ...form, shared: event.target.checked })}
              />
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              {form.id && (
                <Button variant="ghost" size="sm" onClick={() => setForm(empty)}>
                  {t('common.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                icon={form.id ? <Check /> : <Plus />}
                loading={saving}
                disabled={!form.shortcut.trim() || !form.text.trim()}
                onClick={() => void save()}
              >
                {form.id ? t('common.save') : t('inbox.replies.add')}
              </Button>
            </span>
          </div>
          <p className="text-[11px] text-content-tertiary">{t('inbox.replies.nameHint')}</p>
        </div>

        {replies.length === 0 ? (
          <p className="py-6 text-center text-sm text-content-tertiary">{t('inbox.replies.empty')}</p>
        ) : (
          <ul className="max-h-[45vh] divide-y divide-border-subtle overflow-y-auto rounded-2xl ring-1 ring-border-subtle">
            {replies.map((reply) => (
              <li key={reply.id} className="flex items-start gap-3 px-3 py-2.5">
                <span className="ltr-content shrink-0 rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-xs font-semibold text-primary-text">
                  /{reply.shortcut}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-pre-wrap text-sm text-content">{reply.text}</span>
                  {reply.shared && <span className="text-[11px] font-semibold text-success-text">{t('inbox.replies.sharedBadge')}</span>}
                </span>
                {(reply.mine || canShare) && (
                  <span className="flex shrink-0 gap-0.5">
                    {reply.mine && (
                      <button
                        type="button"
                        aria-label={t('inbox.edit')}
                        onClick={() => setForm({ id: reply.id, shortcut: reply.shortcut, text: reply.text, shared: reply.shared })}
                        className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t('inbox.delete')}
                      onClick={() => onRemove(reply.id)}
                      className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-danger-text"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** The person's labels: a name and a colour each. */
export function LabelsDialog({
  open,
  onClose,
  labels,
  onSave,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  labels: InboxLabel[];
  onSave: (label: { id?: string; name: string; color: string }) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[5]!);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={t('inbox.labels.title')} description={t('inbox.labels.hint')}>
      <div className="space-y-4">
        <div className="space-y-2 rounded-2xl bg-surface-sunken p-3">
          <div className="flex gap-2">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('inbox.labels.name')} maxLength={30} />
            <Button
              icon={<Plus />}
              loading={saving}
              disabled={!name.trim()}
              onClick={async () => {
                setSaving(true);
                if (await onSave({ name, color })) setName('');
                setSaving(false);
              }}
            >
              {t('inbox.labels.add')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {LABEL_COLORS.map((entry) => (
              <button
                key={entry}
                type="button"
                aria-label={entry}
                onClick={() => setColor(entry)}
                className={`size-7 rounded-full ring-offset-2 ring-offset-surface-sunken ${color === entry ? 'ring-2 ring-content' : ''}`}
                style={{ background: entry }}
              />
            ))}
          </div>
        </div>
        {labels.length === 0 ? (
          <p className="py-4 text-center text-sm text-content-tertiary">{t('inbox.labels.empty')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-2xl ring-1 ring-border-subtle">
            {labels.map((label) => (
              <li key={label.id} className="flex items-center gap-3 px-3 py-2">
                <Tag className="size-4 shrink-0" style={{ color: label.color }} />
                <span className="flex-1 text-sm font-medium text-content">{label.name}</span>
                <button
                  type="button"
                  aria-label={t('inbox.delete')}
                  onClick={() => onRemove(label.id)}
                  className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-danger-text"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** What can be done to a conversation in the list, as WhatsApp's menu on a chat offers it. */
export function ChatMenu({
  at,
  mark,
  labels,
  onChange,
  onNewLabel,
  onClose,
}: {
  /** The button it opened from, where it is on the screen. */
  at: { top: number; bottom: number; left: number; right: number };
  mark: ChatMark | undefined;
  labels: InboxLabel[];
  onChange: (change: Partial<Pick<ChatMark, 'pinned' | 'archived' | 'markedUnread' | 'labels'>>) => void;
  onNewLabel: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm text-content hover:bg-surface-sunken';
  const chosen = mark?.labels ?? [];
  return (
    <>
      <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
      <div
        role="menu"
        className="fixed z-40 max-h-[70vh] w-56 overflow-y-auto rounded-xl bg-surface py-1 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle"
        style={{
          left: Math.max(8, Math.min(at.right - 224, window.innerWidth - 232)),
          ...(window.innerHeight - at.bottom < 320 ? { bottom: window.innerHeight - at.top + 4 } : { top: at.bottom + 4 }),
        }}
      >
        {!mark?.archived && (
          <button type="button" role="menuitem" className={item} onClick={() => onChange({ pinned: !mark?.pinned })}>
            {mark?.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {mark?.pinned ? t('inbox.menu.unpin') : t('inbox.menu.pin')}
          </button>
        )}
        <button type="button" role="menuitem" className={item} onClick={() => onChange({ archived: !mark?.archived })}>
          {mark?.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          {mark?.archived ? t('inbox.menu.unarchive') : t('inbox.menu.archive')}
        </button>
        <button type="button" role="menuitem" className={item} onClick={() => onChange({ markedUnread: !mark?.markedUnread })}>
          {mark?.markedUnread ? <MailOpen className="size-4" /> : <Mail className="size-4" />}
          {mark?.markedUnread ? t('inbox.menu.markRead') : t('inbox.menu.markUnread')}
        </button>
        <div className="my-1 border-t border-border-subtle" />
        <p className="px-3 pb-1 pt-0.5 text-[11px] font-semibold text-content-tertiary">{t('inbox.labels.title')}</p>
        {labels.map((label) => {
          const on = chosen.includes(label.id);
          return (
            <button
              key={label.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              className={item}
              onClick={() => onChange({ labels: on ? chosen.filter((id) => id !== label.id) : [...chosen, label.id] })}
            >
              <Tag className="size-4" style={{ color: label.color }} />
              <span className="flex-1 truncate">{label.name}</span>
              {on && <Check className="size-4 text-primary-text" />}
            </button>
          );
        })}
        <button type="button" role="menuitem" className={`${item} text-primary-text`} onClick={onNewLabel}>
          <Plus className="size-4" />
          {t('inbox.labels.add')}
        </button>
      </div>
    </>
  );
}
