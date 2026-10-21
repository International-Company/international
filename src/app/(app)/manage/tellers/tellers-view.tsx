'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Select, Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';

/**
 * What each teller gave the office — three numbers, never one.
 *
 * The three are shown as three, side by side, and the fourth column is only
 * their sum. There is deliberately no score: the margin, the counting and the
 * prices given away are different things a person does, and collapsing them
 * into one figure would hide exactly the case the design exists for — the
 * teller with the best margin who has given the office nothing.
 *
 * They are ordered by the sum rather than by the margin, because a list sorted
 * by the first column would put that same man at the top.
 */

interface Row {
  tellerId: string;
  fullNameEn: string;
  fullNameAr: string;
  margin: string;
  deals: number;
  differences: string;
  shortages: number;
  surpluses: number;
  concessions: string;
  concessionCount: number;
  net: string;
  owed: string;
}

interface Observation {
  code: string;
  tone: 'GOOD' | 'NOTE' | 'WARN';
  params?: Record<string, string | number>;
}

interface Report {
  id: string;
  shift: string;
  tellerId: string;
  tellerNameEn: string;
  tellerNameAr: string;
  openedAt: string;
  closedAt: string;
  minutes: number;
  base: string;
  took: string;
  returned: string;
  deals: number;
  dealsByType: string;
  margin: string;
  differences: string;
  concessions: string;
  net: string;
  exceptionsAsked: number;
  observations: Observation[];
}

interface Note {
  id: string;
  tone: string;
  body: string;
  shift: string | null;
  authorEn: string;
  authorAr: string;
  createdAt: string;
  readAt: string | null;
}

const TONES = ['PRAISE', 'NOTE', 'WARNING'] as const;
type Tone = (typeof TONES)[number];

/** How many days back the screen opens on. A month is the span a manager talks in. */
const DEFAULT_DAYS = 30;

export function TellersView({ base }: { base: string }) {
  const { t, ln } = useLocale();
  const toast = useToast();

  const [days, setDays] = useState(DEFAULT_DAYS);
  const [rows, setRows] = useState<Row[]>([]);
  const [opened, setOpened] = useState<Row | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [writing, setWriting] = useState(false);
  const [tone, setTone] = useState<Tone>('NOTE');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);
  const [unpriced, setUnpriced] = useState<string[]>([]);

  const load = useCallback(
    async (tellerId?: string) => {
      const from = new Date(Date.now() - days * 86_400_000).toISOString();
      try {
        const data = await api.get<{ rows: Row[]; notes: Note[]; unpriced: string[] }>(
          `/api/ledger/tellers?from=${encodeURIComponent(from)}${
            tellerId ? `&tellerId=${encodeURIComponent(tellerId)}` : ''
          }`,
        );
        setRows(data.rows);
        setUnpriced(data.unpriced ?? []);
        if (tellerId) setNotes(data.notes);

        // The reports the system wrote for itself, newest first.
        const filed = await api.get<{ rows: Report[] }>(
          `/api/treasury/shift-reports${tellerId ? `?tellerId=${encodeURIComponent(tellerId)}` : ''}`,
        );
        setReports(filed.rows);
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : String(error));
      }
    },
    [days, toast],
  );

  useEffect(() => {
    void load(opened?.tellerId);
  }, [load, opened?.tellerId]);

  const name = (row: { fullNameEn: string; fullNameAr: string }) => ln(row, 'fullName');

  const send = async () => {
    if (!opened) return;
    setBusy(true);
    try {
      await api.post('/api/ledger/tellers', {
        tellerId: opened.tellerId,
        tone,
        body,
      });
      toast.success(t('evaluation.noteSent'));
      setWriting(false);
      setBody('');
      await load(opened.tellerId);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? say(t, error.messageKey, error.params) || error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/*
        A currency nobody has priced is left out of every figure below rather
        than counted one-for-one — so the figures are short by something, and
        saying so is the only honest way to show them.
      */}
      {unpriced.length > 0 && (
        <Alert tone="warning">{t('evaluation.unpriced', { currencies: unpriced.join('، ') })}</Alert>
      )}

      <Card>
        <CardHeader
          title={t('evaluation.title')}
          description={t('evaluation.subtitle')}
          actions={
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="bg-surface border-border-base h-9 rounded-lg border px-2 text-sm"
            >
              {[7, 30, 90].map((value) => (
                <option key={value} value={value}>
                  {t('evaluation.lastDays', { count: value })}
                </option>
              ))}
            </select>
          }
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <EmptyState title={t('evaluation.nobody')} description={t('evaluation.nobodyHint')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] border-collapse">
                <thead>
                  <tr className="bg-surface-sunken text-content-secondary text-xs">
                    <th className="px-3 py-2 text-start font-medium">{t('evaluation.who')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('evaluation.margin')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('evaluation.differences')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('evaluation.concessions')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('evaluation.net')}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.tellerId} className="border-border-subtle border-t text-sm">
                      <td className="px-3 py-2">
                        <span className="font-medium">{name(row)}</span>
                        <span className="text-content-tertiary ms-2 text-xs">
                          {t('evaluation.deals', { count: row.deals })}
                        </span>
                        {BigInt(row.owed) > 0n && (
                          <Badge tone="warning" className="ms-2">
                            {t('evaluation.owes')} <Money value={row.owed} currency={base} />
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end">
                        <Money value={row.margin} decimals={2} />
                      </td>
                      <td className="px-3 py-2 text-end">
                        <Money value={row.differences} decimals={2} colored />
                        {row.shortages > 0 && (
                          <span className="text-content-tertiary ms-1 text-xs">
                            ({t('evaluation.shortages', { count: row.shortages })})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end">
                        <Money value={row.concessions} decimals={2} colored />
                        {row.concessionCount > 0 && (
                          <span className="text-content-tertiary ms-1 text-xs">
                            ({row.concessionCount})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-bold">
                        <Money value={row.net} decimals={2} colored />
                      </td>
                      <td className="px-3 py-2 text-end whitespace-nowrap">
                        {/* What he did, beside what it was worth. */}
                        <Link
                          href={`/manage/activity?teller=${encodeURIComponent(row.tellerId)}`}
                          className="text-primary-text me-1 inline-flex h-8 items-center rounded-md px-3 text-sm hover:underline"
                        >
                          {t('nav.activity')}
                        </Link>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setOpened(row);
                            setNotes([]);
                          }}
                        >
                          {t('evaluation.notes')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {opened && (
        <Card>
          <CardHeader
            title={`${t('evaluation.notes')} — ${name(opened)}`}
            description={t('evaluation.notesHint')}
            actions={
              <Button
                size="sm"
                icon={<MessageSquare className="size-4" />}
                onClick={() => {
                  setWriting(true);
                  setBody('');
                  setTone('NOTE');
                }}
              >
                {t('evaluation.write')}
              </Button>
            }
          />
          <CardBody className="p-0">
            {notes.length === 0 ? (
              <EmptyState title={t('evaluation.noNotes')} />
            ) : (
              <ul className="divide-border-base divide-y">
                {notes.map((note) => (
                  <li key={note.id} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={
                          note.tone === 'WARNING'
                            ? 'danger'
                            : note.tone === 'PRAISE'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {t(`evaluation.tone.${toneKey(note.tone)}`)}
                      </Badge>
                      {note.shift && (
                        <span className="text-content-tertiary font-mono text-xs">{note.shift}</span>
                      )}
                      <Badge tone={note.readAt ? 'success' : 'neutral'}>
                        {note.readAt ? t('evaluation.read') : t('evaluation.unread')}
                      </Badge>
                      <span className="text-content-tertiary ms-auto text-xs">
                        <DateText value={note.createdAt} withTime />
                      </span>
                    </div>
                    <p>{note.body}</p>
                    <p className="text-content-tertiary text-xs">{ln(note, 'author')}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {/* --- What the system filed on its own --------------------------- */}
      <Card>
        <CardHeader title={t('shiftReport.title')} description={t('shiftReport.subtitle')} />
        <CardBody className="p-0">
          {reports.length === 0 ? (
            <EmptyState title={t('shiftReport.none')} description={t('shiftReport.noneHint')} />
          ) : (
            <ul className="divide-border-base divide-y">
              {reports.map((report) => (
                <li key={report.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono ltr-content text-xs">{report.shift}</span>
                    <span className="font-medium">{ln(report, 'tellerName')}</span>
                    <span className="text-content-tertiary text-xs">
                      {t('shiftReport.deals')} {report.deals}
                    </span>
                    <span className="text-content-tertiary text-xs">
                      {t('shiftReport.duration')}{' '}
                      {report.minutes >= 60
                        ? t('shiftReport.hours', { count: Math.round(report.minutes / 60) })
                        : t('shiftReport.minutes', { count: report.minutes })}
                    </span>
                    <span className="ms-auto text-xs font-bold">
                      <Money value={report.net} decimals={2} colored />
                    </span>
                  </div>

                  {/*
                    The noticing, worst first — the reason this is a report and
                    not a table. Rendered from codes so the words are the
                    reader's, and nothing was written in prose about a person's
                    money.
                  */}
                  <ul className="space-y-1">
                    {report.observations.map((entry, index) => (
                      <li key={`${entry.code}-${index}`} className="flex items-start gap-2">
                        <Badge
                          tone={
                            entry.tone === 'WARN' ? 'danger' : entry.tone === 'GOOD' ? 'success' : 'neutral'
                          }
                        >
                          {t(`shiftReport.tone.${entry.tone}`)}
                        </Badge>
                        <span className="text-content-secondary text-xs leading-5">
                          {t(`shiftReport.say.${entry.code}` as never, entry.params)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Dialog
        open={writing}
        onClose={() => setWriting(false)}
        title={t('evaluation.write')}
        description={t('evaluation.writeHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setWriting(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={send} loading={busy} disabled={body.trim().length < 2}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('evaluation.toneLabel')}>
            {(field) => (
              <Select
                {...field}
                value={tone}
                onChange={(event) => setTone(event.target.value as Tone)}
                options={TONES.map((value) => ({
                  value,
                  label: t(`evaluation.tone.${value}`),
                }))}
              />
            )}
          </Field>
          <Field label={t('evaluation.body')}>
            {(field) => (
              <Textarea
                {...field}
                rows={4}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function toneKey(tone: string): Tone {
  return (TONES as readonly string[]).includes(tone) ? (tone as Tone) : 'NOTE';
}
