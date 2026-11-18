'use client';

import { useEffect, useState } from 'react';
import { CornerUpRight } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Textarea } from '@/ui/form';

interface Group {
  id: string;
  name: string;
}

interface Message {
  group: string;
  text: string;
  mediaId: string | null;
  mediaKind: string | null;
}

/** The groups last chosen to carry out a transfer, ready ticked for the next one. */
const LAST_TARGETS = 'bank.forward.lastTargets';

function lastTargets(): Group[] {
  try {
    const raw = window.localStorage.getItem(LAST_TARGETS);
    const list = raw ? (JSON.parse(raw) as Group[]) : [];
    return Array.isArray(list) ? list.filter((group) => group?.id && group?.name) : [];
  } catch {
    return [];
  }
}

function rememberTargets(groups: Group[]) {
  try {
    window.localStorage.setItem(LAST_TARGETS, JSON.stringify(groups));
  } catch {
    // Not kept: ticked again by hand next time.
  }
}

/**
 * A transfer's message in the bank group, passed on by the bot to the groups
 * that carry it out — its words open to correct first, its photo with it.
 */
export function ForwardDialog({
  messageId,
  onClose,
  onDone,
}: {
  messageId: string | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [message, setMessage] = useState<Message | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [targets, setTargets] = useState<Group[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
    );

  useEffect(() => {
    if (!messageId) return;
    setMessage(null);
    setText('');
    let gone = false;
    api
      .get<{ message: Message }>(`/api/bank/groups/messages/${messageId}/trace`)
      .then((trace) => {
        if (gone) return;
        setMessage(trace.message);
        setText(trace.message.text);
      })
      .catch((cause) => {
        if (!gone) failure(cause);
      });
    if (!groups) {
      api
        .get<Group[]>('/api/bank/groups/all')
        .then((all) => {
          if (gone) return;
          setGroups(all);
          // Last time's groups, those still there.
          setTargets(lastTargets().filter((group) => all.some((entry) => entry.id === group.id)));
        })
        .catch((cause) => {
          if (gone) return;
          setGroups([]);
          failure(cause);
        });
    }
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const send = async () => {
    if (!messageId || targets.length === 0) return;
    setBusy(true);
    try {
      const result = await api.post<{ sent: string[] }>(`/api/bank/groups/messages/${messageId}/forward`, {
        targets,
        text,
      });
      rememberTargets(targets);
      toast.success(t('bankFeed.forwarded'), result.sent.join('، '));
      onDone?.();
      onClose();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (group: Group) =>
    setTargets((chosen) =>
      chosen.some((entry) => entry.id === group.id)
        ? chosen.filter((entry) => entry.id !== group.id)
        : [...chosen, group],
    );

  return (
    <Dialog
      open={messageId !== null}
      onClose={onClose}
      title={t('bank.forwardTitle')}
      description={t('bank.forwardHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<CornerUpRight />}
            disabled={!message || targets.length === 0}
            onClick={() => void send()}
          >
            {t('bankFeed.send')}
            {targets.length > 0 && <span className="tabular-nums"> · {targets.length}</span>}
          </Button>
        </>
      }
    >
      {!message ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <div className="space-y-3">
          {message.mediaId && message.mediaKind === 'image' && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`/api/bank/groups/media/${message.mediaId}`}
              alt=""
              className="max-h-40 rounded-lg object-contain"
            />
          )}
          <Field label={t('bankFeed.text')}>
            {(props) => (
              <Textarea {...props} rows={5} value={text} onChange={(event) => setText(event.target.value)} />
            )}
          </Field>
          <p className="text-xs font-medium text-content-secondary">{t('bank.forwardTargets')}</p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {groups === null ? (
              <Skeleton className="h-24" />
            ) : groups.length === 0 ? (
              <p className="rounded-lg bg-surface-sunken p-3 text-center text-xs text-content-tertiary">{t('bank.noGroups')}</p>
            ) : (
              groups
                // Not back into the group it is in.
                .filter((group) => group.name !== message.group)
                .map((group) => (
                  <label
                    key={group.id}
                    className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-sunken"
                  >
                    <input
                      type="checkbox"
                      checked={targets.some((entry) => entry.id === group.id)}
                      onChange={() => toggle(group)}
                    />
                    {group.name}
                  </label>
                ))
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
