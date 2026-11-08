'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Plus, Save, Send, Trash2, User } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import type { BotProfile } from '@/modules/whatsapp/bot-profile';
import { Field, Input, NumberInput, Switch, Textarea } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Skeleton } from '@/ui/primitives';

type Gap = 'NOT_LINKED' | 'NO_GROUP' | 'SWITCHED_OFF' | 'NO_KEY';

interface Panel {
  profile: BotProfile;
  enabled: boolean;
  dailyLimit: number;
  gaps: Gap[];
  number: string | null;
  currencies: string[];
  destinations: string[];
  preview: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handover?: boolean;
}

const SECTIONS = ['cash', 'bank', 'usdt', 'remittances'] as const;

/** The three the manager edits, as one value to compare with what is saved. */
const draftOf = (panel: Panel) =>
  JSON.stringify({ profile: panel.profile, enabled: panel.enabled, dailyLimit: panel.dailyLimit });

export function PrivateBotView({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const [saved, setSaved] = useState<Panel | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      ),
    [t, toast],
  );

  useEffect(() => {
    api
      .get<Panel>('/api/admin/private-bot')
      .then((loaded) => {
        setSaved(loaded);
        setPanel(loaded);
      })
      .catch(failure);
    // Once, on opening: a later reload would throw away what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [turns, asking]);

  if (!panel || !saved) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { profile } = panel;
  const dirty = draftOf(panel) !== draftOf(saved);
  const edit = (change: Partial<BotProfile>) =>
    setPanel({ ...panel, profile: { ...profile, ...change } });
  const toggled = (list: string[], entry: string) =>
    list.includes(entry) ? list.filter((item) => item !== entry) : [...list, entry];

  const save = async () => {
    setSaving(true);
    try {
      const fresh = await api.put<Panel>('/api/admin/private-bot', {
        profile,
        enabled: panel.enabled,
        dailyLimit: panel.dailyLimit,
      });
      setSaved(fresh);
      setPanel(fresh);
      toast.success(t('privateBot.saved'));
    } catch (cause) {
      failure(cause);
    } finally {
      setSaving(false);
    }
  };

  const ask = async () => {
    const content = question.trim();
    if (!content || asking) return;
    const asked: Turn[] = [...turns, { role: 'user', content }];
    setTurns(asked);
    setQuestion('');
    setAsking(true);
    try {
      const answer = await api.post<{ reply: string; handover: boolean }>(
        '/api/admin/private-bot',
        { turns: asked.slice(-12).map(({ role, content: words }) => ({ role, content: words })) },
      );
      setTurns([
        ...asked,
        { role: 'assistant', content: answer.reply, handover: answer.handover },
      ]);
    } catch (cause) {
      failure(cause);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="grid items-start gap-4 pb-20 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-4">
        {/* ============ Is it answering ============ */}
        <Card>
          <CardHeader
            title={t('privateBot.statusTitle')}
            description={panel.number ? `+${panel.number}` : t('privateBot.notLinked')}
            actions={
              saved.gaps.length === 0 ? (
                <Badge tone="success">{t('privateBot.ready')}</Badge>
              ) : (
                <Badge tone="warning">{t('privateBot.notReady')}</Badge>
              )
            }
          />
          <CardBody className="space-y-4">
            {saved.gaps.length > 0 && (
              <Alert tone="warning" title={t('whatsapp.privateNotReady')}>
                <ul className="list-inside list-disc space-y-1">
                  {saved.gaps.map((gap) => (
                    <li key={gap}>{t(`whatsapp.privateGap.${gap}`)}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Switch
                checked={panel.enabled}
                disabled={!canManage}
                onCheckedChange={(enabled) => setPanel({ ...panel, enabled })}
                label={t('privateBot.enabled')}
                description={t('privateBot.enabledHint')}
              />
              <Field label={t('privateBot.dailyLimit')} hint={t('privateBot.dailyLimitHint')}>
                {(props) => (
                  <NumberInput
                    {...props}
                    min={0}
                    max={5000}
                    disabled={!canManage}
                    value={panel.dailyLimit}
                    onValueChange={(dailyLimit) => setPanel({ ...panel, dailyLimit })}
                  />
                )}
              </Field>
            </div>
          </CardBody>
        </Card>

        {/* ============ About the office ============ */}
        <Card>
          <CardHeader title={t('privateBot.aboutTitle')} description={t('privateBot.aboutHint')} />
          <CardBody>
            <Textarea
              rows={6}
              maxLength={4000}
              disabled={!canManage}
              aria-label={t('privateBot.aboutTitle')}
              placeholder={t('privateBot.aboutPlaceholder')}
              value={profile.about}
              onChange={(event) => edit({ about: event.target.value })}
            />
          </CardBody>
        </Card>

        {/* ============ The greeting ============ */}
        <Card>
          <CardHeader
            title={t('privateBot.welcomeTitle')}
            description={t('privateBot.welcomeHint')}
          />
          <CardBody>
            <Textarea
              rows={5}
              maxLength={1000}
              disabled={!canManage}
              aria-label={t('privateBot.welcomeTitle')}
              placeholder={t('privateBot.welcomePlaceholder')}
              value={profile.welcome}
              onChange={(event) => edit({ welcome: event.target.value })}
            />
          </CardBody>
        </Card>

        {/* ============ Prepared answers ============ */}
        <Card>
          <CardHeader
            title={t('privateBot.faqTitle')}
            description={t('privateBot.faqHint')}
            actions={
              canManage && profile.faqs.length < 50 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus />}
                  onClick={() => edit({ faqs: [...profile.faqs, { question: '', answer: '' }] })}
                >
                  {t('privateBot.add')}
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-3">
            {profile.faqs.length === 0 && (
              <p className="text-sm text-content-tertiary">{t('privateBot.faqEmpty')}</p>
            )}
            {profile.faqs.map((row, index) => (
              <div key={index} className="flex items-start gap-2 rounded-xl bg-surface-sunken p-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    maxLength={300}
                    disabled={!canManage}
                    aria-label={t('privateBot.question')}
                    placeholder={t('privateBot.question')}
                    value={row.question}
                    onChange={(event) =>
                      edit({
                        faqs: profile.faqs.map((item, at) =>
                          at === index ? { ...item, question: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Textarea
                    rows={2}
                    maxLength={1000}
                    disabled={!canManage}
                    aria-label={t('privateBot.answer')}
                    placeholder={t('privateBot.answer')}
                    value={row.answer}
                    onChange={(event) =>
                      edit({
                        faqs: profile.faqs.map((item, at) =>
                          at === index ? { ...item, answer: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </div>
                {canManage && (
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={() => edit({ faqs: profile.faqs.filter((_, at) => at !== index) })}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface hover:text-danger-text"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </CardBody>
        </Card>

        {/* ============ Prices the system does not hold ============ */}
        <Card>
          <CardHeader
            title={t('privateBot.extraTitle')}
            description={t('privateBot.extraHint')}
            actions={
              canManage && profile.extraPrices.length < 50 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus />}
                  onClick={() =>
                    edit({ extraPrices: [...profile.extraPrices, { item: '', price: '' }] })
                  }
                >
                  {t('privateBot.add')}
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-2">
            {profile.extraPrices.length === 0 && (
              <p className="text-sm text-content-tertiary">{t('privateBot.extraEmpty')}</p>
            )}
            {profile.extraPrices.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  className="min-w-0 flex-1"
                  maxLength={120}
                  disabled={!canManage}
                  aria-label={t('privateBot.extraItem')}
                  placeholder={t('privateBot.extraItem')}
                  value={row.item}
                  onChange={(event) =>
                    edit({
                      extraPrices: profile.extraPrices.map((item, at) =>
                        at === index ? { ...item, item: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Input
                  className="min-w-0 flex-1"
                  maxLength={120}
                  disabled={!canManage}
                  aria-label={t('privateBot.extraPrice')}
                  placeholder={t('privateBot.extraPrice')}
                  value={row.price}
                  onChange={(event) =>
                    edit({
                      extraPrices: profile.extraPrices.map((item, at) =>
                        at === index ? { ...item, price: event.target.value } : item,
                      ),
                    })
                  }
                />
                {canManage && (
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={() =>
                      edit({ extraPrices: profile.extraPrices.filter((_, at) => at !== index) })
                    }
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-danger-text"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </CardBody>
        </Card>

        {/* ============ What a customer may be told ============ */}
        <Card>
          <CardHeader title={t('privateBot.showTitle')} description={t('privateBot.showHint')} />
          <CardBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {SECTIONS.map((section) => (
                <Switch
                  key={section}
                  checked={profile.show[section]}
                  disabled={!canManage}
                  onCheckedChange={(on) =>
                    edit({ show: { ...profile.show, [section]: on } })
                  }
                  label={t(`privateBot.show.${section}`)}
                />
              ))}
            </div>

            {panel.currencies.length > 0 && (
              <Chips
                title={t('privateBot.currencies')}
                entries={panel.currencies}
                hidden={profile.hiddenCurrencies}
                disabled={!canManage}
                onToggle={(code) =>
                  edit({ hiddenCurrencies: toggled(profile.hiddenCurrencies, code) })
                }
              />
            )}

            {panel.destinations.length > 0 && profile.show.remittances && (
              <Chips
                title={t('privateBot.destinations')}
                entries={panel.destinations}
                hidden={profile.hiddenDestinations}
                disabled={!canManage}
                onToggle={(destination) =>
                  edit({ hiddenDestinations: toggled(profile.hiddenDestinations, destination) })
                }
              />
            )}
          </CardBody>
        </Card>
      </div>

      {/* ============ See it working ============ */}
      <div className="min-w-0 space-y-4 lg:sticky lg:top-4">
        <Card>
          <CardHeader title={t('privateBot.tryTitle')} description={t('privateBot.tryHint')} />
          <CardBody className="space-y-3">
            <div className="flex h-72 flex-col gap-2 overflow-y-auto rounded-xl bg-surface-sunken p-3">
              {turns.length === 0 && !asking && (
                <p className="m-auto max-w-56 text-center text-sm text-content-tertiary">
                  {t('privateBot.tryEmpty')}
                </p>
              )}
              {turns.map((turn, index) => (
                <div
                  key={index}
                  className={`flex items-end gap-2 ${turn.role === 'user' ? '' : 'flex-row-reverse'}`}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary ring-1 ring-border-subtle">
                    {turn.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
                  </span>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                      turn.role === 'user'
                        ? 'bg-surface text-content ring-1 ring-border-subtle'
                        : 'bg-primary-subtle text-content'
                    }`}
                  >
                    {turn.content}
                    {turn.handover && (
                      <span className="mt-1 block text-xs font-medium text-warning-text">
                        {t('privateBot.tryHandover')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {asking && (
                <Loader2 className="size-4 animate-spin self-end text-content-tertiary" />
              )}
              <div ref={chatEnd} />
            </div>
            {dirty && <p className="text-xs text-warning-text">{t('privateBot.tryUnsaved')}</p>}
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <Input
                className="min-w-0 flex-1"
                maxLength={800}
                disabled={!canManage}
                aria-label={t('privateBot.tryPlaceholder')}
                placeholder={t('privateBot.tryPlaceholder')}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                icon={<Send />}
                disabled={!canManage || !question.trim() || asking}
                aria-label={t('privateBot.tryAsk')}
              />
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('privateBot.previewTitle')}
            description={t('privateBot.previewHint')}
          />
          <CardBody>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-content-secondary">
              {saved.preview}
            </pre>
          </CardBody>
        </Card>
      </div>

      {/* ============ Save ============ */}
      {canManage && dirty && (
        <div className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-2xl bg-surface p-3 shadow-[var(--shadow-lg)] ring-1 ring-border-base">
          <span className="text-sm font-medium text-content">{t('privateBot.unsaved')}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPanel(saved)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" icon={<Save />} loading={saving} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Each entry a chip: filled when customers may hear of it, struck through when they may not. */
function Chips({
  title,
  entries,
  hidden,
  disabled,
  onToggle,
}: {
  title: string;
  entries: string[];
  hidden: string[];
  disabled: boolean;
  onToggle: (entry: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-content-secondary">{title}</p>
      <div className="flex flex-wrap gap-2">
        {entries.map((entry) => {
          const shown = !hidden.includes(entry);
          return (
            <button
              key={entry}
              type="button"
              disabled={disabled}
              aria-pressed={shown}
              onClick={() => onToggle(entry)}
              className={`h-9 rounded-full px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                shown
                  ? 'bg-primary-subtle text-primary-text ring-1 ring-primary'
                  : 'bg-surface-sunken text-content-tertiary line-through'
              }`}
            >
              {entry}
            </button>
          );
        })}
      </div>
    </div>
  );
}
