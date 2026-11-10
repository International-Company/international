'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  Bot,
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Trash2,
  User,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import type { BotProfile } from '@/modules/whatsapp/bot-profile';
import { Field, Input, NumberInput, Switch, Textarea } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { CountryPricesEditor } from './country-prices-editor';
import { NodeList } from './flow-editor';
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
  usage: {
    today: { answers: number; photos: number; cost: number };
    month: { answers: number; photos: number; cost: number };
  };
  creditOutAt: number | null;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handover?: boolean;
}

const SECTIONS = ['cash', 'bank', 'usdt', 'remittances'] as const;

/** The setup in the order it is done. */
const STEPS = [
  { id: 'status', Icon: Activity },
  { id: 'flows', Icon: GitBranch },
  { id: 'info', Icon: BookOpen },
  { id: 'prices', Icon: Tags },
  { id: 'behavior', Icon: SlidersHorizontal },
  { id: 'rules', Icon: ShieldCheck },
] as const;

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
  const flowState = useRef<unknown>(null);
  const [section, setSection] = useState<(typeof STEPS)[number]['id']>('status');

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
      const answer = await api.post<{ reply: string; handover: boolean; flowState?: unknown }>(
        '/api/admin/private-bot',
        {
          turns: asked.slice(-12).map(({ role, content: words }) => ({ role, content: words })),
          flowState: flowState.current,
        },
      );
      flowState.current = answer.flowState ?? null;
      setTurns([
        ...asked,
        {
          role: 'assistant',
          content: answer.reply || t('privateBot.trySilent'),
          handover: answer.handover,
        },
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
        <nav
          aria-label={t('privateBot.title')}
          className="grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6"
        >
          {STEPS.map(({ id, Icon }, index) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'step' : undefined}
              onClick={() => setSection(id)}
              className={`flex items-start gap-3 rounded-2xl p-3 text-start ring-1 transition-colors ${
                section === id
                  ? 'bg-primary-subtle ring-primary'
                  : 'bg-surface ring-border-subtle hover:bg-surface-sunken'
              }`}
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
                  section === id
                    ? 'bg-primary text-white'
                    : 'bg-surface-sunken text-content-secondary'
                }`}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-content">
                  {index + 1}. {t(`privateBot.step.${id}`)}
                </span>
                <span className="mt-0.5 block text-xs text-content-secondary">
                  {t(`privateBot.stepHint.${id}`)}
                </span>
              </span>
            </button>
          ))}
        </nav>

        {section === 'status' && (
          <>
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
                    {(saved.gaps.includes('NOT_LINKED') || saved.gaps.includes('NO_GROUP')) && (
                      <a
                        href="/manage/settings"
                        className="mt-2 inline-flex items-center gap-1.5 font-semibold underline"
                      >
                        <ExternalLink className="size-3.5" />
                        {t('privateBot.openWhatsappSettings')}
                      </a>
                    )}
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

            {/* ============ What it has cost ============ */}
            <Card>
              <CardHeader
                title={t('privateBot.usageTitle')}
                description={t('privateBot.usageHint')}
              />
              <CardBody className="space-y-3">
                {saved.creditOutAt && <Alert tone="danger">{t('privateBot.creditOut')}</Alert>}
                <div className="grid grid-cols-2 gap-3">
                  {(['today', 'month'] as const).map((period) => (
                    <div key={period} className="rounded-xl bg-surface-sunken p-3">
                      <p className="text-xs font-medium text-content-secondary">
                        {t(`privateBot.usage.${period}`)}
                      </p>
                      <p className="mt-1 text-2xl font-bold tabular-nums text-content">
                        ${saved.usage[period].cost.toFixed(2)}
                      </p>
                      <p className="mt-1 text-xs text-content-secondary">
                        {t('privateBot.usageCounts', {
                          answers: saved.usage[period].answers,
                          photos: saved.usage[period].photos,
                        })}
                      </p>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          </>
        )}

        {section === 'info' && (
          <>
            {/* ============ About the office ============ */}
            <Card>
              <CardHeader
                title={t('privateBot.aboutTitle')}
                description={t('privateBot.aboutHint')}
              />
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

            <AccountList
              accounts={profile.accounts}
              disabled={!canManage}
              onChange={(accounts) => edit({ accounts })}
            />

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
                      onClick={() =>
                        edit({ faqs: [...profile.faqs, { question: '', answer: '' }] })
                      }
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
                  <div
                    key={index}
                    className="flex items-start gap-2 rounded-xl bg-surface-sunken p-3"
                  >
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
          </>
        )}

        {section === 'prices' && (
          <>
            <CountryPricesEditor
              rows={profile.countryPrices}
              disabled={!canManage}
              onChange={(countryPrices) => edit({ countryPrices })}
            />

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
                        edit({
                          extraPrices: [...profile.extraPrices, { item: '', buy: '', sell: '' }],
                        })
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
                {profile.extraPrices.map((row, index) => {
                  const change = (patch: Partial<typeof row>) =>
                    edit({
                      extraPrices: profile.extraPrices.map((item, at) =>
                        at === index ? { ...item, ...patch } : item,
                      ),
                    });
                  return (
                    <div
                      key={index}
                      className="flex items-start gap-2 rounded-xl bg-surface-sunken p-3"
                    >
                      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr]">
                        <Field
                          label={t('privateBot.extraItem')}
                          className="col-span-2 sm:col-span-1"
                        >
                          {(props) => (
                            <Input
                              {...props}
                              maxLength={120}
                              disabled={!canManage}
                              placeholder={t('privateBot.extraItemExample')}
                              value={row.item}
                              onChange={(event) => change({ item: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label={t('privateBot.extraBuy')}>
                          {(props) => (
                            <Input
                              {...props}
                              dir="ltr"
                              maxLength={40}
                              disabled={!canManage}
                              placeholder="0.00"
                              value={row.buy}
                              onChange={(event) => change({ buy: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label={t('privateBot.extraSell')}>
                          {(props) => (
                            <Input
                              {...props}
                              dir="ltr"
                              maxLength={40}
                              disabled={!canManage}
                              placeholder="0.00"
                              value={row.sell}
                              onChange={(event) => change({ sell: event.target.value })}
                            />
                          )}
                        </Field>
                      </div>
                      {canManage && (
                        <button
                          type="button"
                          aria-label={t('common.delete')}
                          onClick={() =>
                            edit({
                              extraPrices: profile.extraPrices.filter((_, at) => at !== index),
                            })
                          }
                          className="mt-6 flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface hover:text-danger-text"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </CardBody>
            </Card>

            {/* ============ What a customer may be told ============ */}
            <Card>
              <CardHeader
                title={t('privateBot.showTitle')}
                description={t('privateBot.showHint')}
              />
              <CardBody className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  {SECTIONS.map((section) => (
                    <Switch
                      key={section}
                      checked={profile.show[section]}
                      disabled={!canManage}
                      onCheckedChange={(on) => edit({ show: { ...profile.show, [section]: on } })}
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
          </>
        )}

        {section === 'flows' && (
          <Card>
            <CardHeader
              title={t('privateBot.flowsTitle')}
              description={t('privateBot.flowsHint')}
            />
            <CardBody className="space-y-3">
              <Field label={t('privateBot.flowPrompt')}>
                {(props) => (
                  <Input
                    {...props}
                    maxLength={300}
                    disabled={!canManage}
                    placeholder={t('privateBot.flowPromptExample')}
                    value={profile.flow.prompt}
                    onChange={(event) =>
                      edit({ flow: { ...profile.flow, prompt: event.target.value } })
                    }
                  />
                )}
              </Field>
              <NodeList
                nodes={profile.flow.children}
                depth={0}
                options={{
                  currencies: panel.currencies,
                  destinations: panel.destinations,
                  accounts: profile.accounts.map((row) => row.bank),
                  disabled: !canManage,
                }}
                onChange={(children) => edit({ flow: { ...profile.flow, children } })}
              />
            </CardBody>
          </Card>
        )}

        {section === 'rules' && (
          <>
            <RuleList
              title={t('privateBot.rulesTitle')}
              hint={t('privateBot.rulesHint')}
              placeholder={t('privateBot.rulesPlaceholder')}
              entries={profile.rules}
              max={30}
              maxLength={300}
              disabled={!canManage}
              onChange={(rules) => edit({ rules })}
            />
            <RuleList
              title={t('privateBot.blockedTitle')}
              hint={t('privateBot.blockedHint')}
              placeholder={t('privateBot.blockedPlaceholder')}
              entries={profile.blockedWords}
              max={100}
              maxLength={60}
              disabled={!canManage}
              onChange={(blockedWords) => edit({ blockedWords })}
            />
            <RuleList
              title={t('privateBot.topicsTitle')}
              hint={t('privateBot.topicsHint')}
              placeholder={t('privateBot.topicsPlaceholder')}
              entries={profile.humanTopics}
              max={100}
              maxLength={60}
              disabled={!canManage}
              onChange={(humanTopics) => edit({ humanTopics })}
            />
          </>
        )}

        {section === 'behavior' && (
          <>
            {/* ============ How it behaves ============ */}
            <Card>
              <CardHeader title={t('privateBot.behaviorTitle')} />
              <CardBody className="space-y-5">
                <Switch
                  checked={profile.hours.enabled}
                  disabled={!canManage}
                  onCheckedChange={(enabled) => edit({ hours: { ...profile.hours, enabled } })}
                  label={t('privateBot.hoursEnabled')}
                  description={t('privateBot.hoursHint')}
                />
                {profile.hours.enabled && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t('privateBot.opens')}>
                        {(props) => (
                          <Input
                            {...props}
                            type="time"
                            dir="ltr"
                            disabled={!canManage}
                            value={profile.hours.open}
                            onChange={(event) =>
                              edit({ hours: { ...profile.hours, open: event.target.value } })
                            }
                          />
                        )}
                      </Field>
                      <Field label={t('privateBot.closes')}>
                        {(props) => (
                          <Input
                            {...props}
                            type="time"
                            dir="ltr"
                            disabled={!canManage}
                            value={profile.hours.close}
                            onChange={(event) =>
                              edit({ hours: { ...profile.hours, close: event.target.value } })
                            }
                          />
                        )}
                      </Field>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium text-content-secondary">
                        {t('privateBot.closedDays')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {[6, 0, 1, 2, 3, 4, 5].map((day) => {
                          const closed = profile.hours.closedDays.includes(day);
                          return (
                            <button
                              key={day}
                              type="button"
                              disabled={!canManage}
                              aria-pressed={closed}
                              onClick={() =>
                                edit({
                                  hours: {
                                    ...profile.hours,
                                    closedDays: closed
                                      ? profile.hours.closedDays.filter((item) => item !== day)
                                      : [...profile.hours.closedDays, day],
                                  },
                                })
                              }
                              className={`h-9 rounded-full px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                                closed
                                  ? 'bg-warning-subtle text-warning-text ring-1 ring-warning'
                                  : 'bg-surface-sunken text-content-secondary'
                              }`}
                            >
                              {t(`privateBot.day.d${day}` as never)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('privateBot.takeover')} hint={t('privateBot.takeoverHint')}>
                    {(props) => (
                      <NumberInput
                        {...props}
                        min={1}
                        max={10080}
                        disabled={!canManage}
                        value={profile.takeoverMinutes}
                        onValueChange={(takeoverMinutes) => edit({ takeoverMinutes })}
                      />
                    )}
                  </Field>
                  <Field label={t('privateBot.retention')} hint={t('privateBot.retentionHint')}>
                    {(props) => (
                      <NumberInput
                        {...props}
                        min={7}
                        max={730}
                        disabled={!canManage}
                        value={profile.retentionDays}
                        onValueChange={(retentionDays) => edit({ retentionDays })}
                      />
                    )}
                  </Field>
                </div>
              </CardBody>
            </Card>
          </>
        )}
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
                    {turn.role === 'user' ? (
                      <User className="size-3.5" />
                    ) : (
                      <Bot className="size-3.5" />
                    )}
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
              {asking && <Loader2 className="size-4 animate-spin self-end text-content-tertiary" />}
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

/** The banks the bot can give, exactly as written here. */
function AccountList({
  accounts,
  disabled,
  onChange,
}: {
  accounts: BotProfile['accounts'];
  disabled: boolean;
  onChange: (accounts: BotProfile['accounts']) => void;
}) {
  const { t } = useLocale();
  const change = (index: number, patch: Partial<BotProfile['accounts'][number]>) =>
    onChange(accounts.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <Card>
      <CardHeader
        title={t('privateBot.accountsTitle')}
        description={t('privateBot.accountsHint')}
        actions={
          !disabled && accounts.length < 30 ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => onChange([...accounts, { bank: '', name: '', account: '' }])}
            >
              {t('privateBot.add')}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-2">
        {accounts.length === 0 && (
          <p className="text-sm text-content-tertiary">{t('privateBot.listEmpty')}</p>
        )}
        {accounts.map((row, index) => (
          <div key={index} className="flex items-start gap-2 rounded-xl bg-surface-sunken p-3">
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-3">
              <Field label={t('privateBot.accountBank')}>
                {(props) => (
                  <Input
                    {...props}
                    maxLength={80}
                    disabled={disabled}
                    value={row.bank}
                    onChange={(event) => change(index, { bank: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('privateBot.accountName')}>
                {(props) => (
                  <Input
                    {...props}
                    maxLength={120}
                    disabled={disabled}
                    value={row.name}
                    onChange={(event) => change(index, { name: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('privateBot.accountNumber')}>
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    maxLength={80}
                    disabled={disabled}
                    value={row.account}
                    onChange={(event) => change(index, { account: event.target.value })}
                  />
                )}
              </Field>
            </div>
            {!disabled && (
              <button
                type="button"
                aria-label={t('common.delete')}
                onClick={() => onChange(accounts.filter((_, at) => at !== index))}
                className="mt-6 flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface hover:text-danger-text"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

/** A list the manager writes, one entry to a row. */
function RuleList({
  title,
  hint,
  placeholder,
  entries,
  max,
  maxLength,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  placeholder: string;
  entries: string[];
  max: number;
  maxLength: number;
  disabled: boolean;
  onChange: (entries: string[]) => void;
}) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader
        title={title}
        description={hint}
        actions={
          !disabled && entries.length < max ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => onChange([...entries, ''])}
            >
              {t('privateBot.add')}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-2">
        {entries.length === 0 && (
          <p className="text-sm text-content-tertiary">{t('privateBot.listEmpty')}</p>
        )}
        {entries.map((entry, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              maxLength={maxLength}
              disabled={disabled}
              aria-label={title}
              placeholder={placeholder}
              value={entry}
              onChange={(event) =>
                onChange(entries.map((item, at) => (at === index ? event.target.value : item)))
              }
            />
            {!disabled && (
              <button
                type="button"
                aria-label={t('common.delete')}
                onClick={() => onChange(entries.filter((_, at) => at !== index))}
                className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-danger-text"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
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
