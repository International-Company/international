'use client';

import { useMemo, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { Button } from './primitives';
import { Dialog, useToast } from './overlay';
import { Field, Input } from './form';

/**
 * Attaching a customer to a piece of work.
 *
 * Every counter surface needs this and needs it to behave identically — the
 * same minimum term before searching, the same way a chosen customer is shown
 * and cleared, the same route to registering a new one. When it lived inside
 * one form, the next screen that needed it would have grown a near-copy that
 * drifted, and an operator would have learned two slightly different controls
 * for one idea.
 */

export interface CustomerHit {
  id: string;
  code: string;
  fullNameEn: string;
  fullNameAr: string;
  phone: string | null;
  kycStatus?: string;
  riskLevel?: string;
}

export function CustomerPicker({
  value,
  onChange,
  permissions,
  required,
  error,
  label,
}: {
  value: CustomerHit | null;
  onChange: (customer: CustomerHit | null) => void;
  permissions: string[];
  required?: boolean;
  error?: string;
  label?: string;
}) {
  const { t, ln } = useLocale();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CustomerHit[]>([]);

  /*
   * Registering somebody without leaving the counter.
   *
   * This used to navigate to the customers screen, which threw away whatever
   * the teller was in the middle of — an arrival they had just picked, a deal
   * they had just priced — with a customer standing in front of them. The
   * registration screen is the right place to record a passport and a credit
   * limit; it is the wrong place to be sent to mid-transaction.
   *
   * So the counter asks for the two things a counter actually needs: a name and
   * a number. Everything else the customer record can hold is left to the
   * screen built for it, and can be filled in later without the queue waiting.
   */
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    // Whatever they searched for is almost always the name they are about to
    // type, so it is already there.
    setName(query.trim());
    setPhone('');
    setCreating(true);
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    setSaving(true);
    try {
      const created = await api.post<CustomerHit>('/api/customers', {
        /*
         * One name, written once. The counter works in Arabic and a teller
         * asked for the same name twice would type it twice or leave one blank;
         * the record needs both fields, so the name given fills both until
         * somebody edits it on the customers screen.
         */
        fullNameAr: trimmed,
        fullNameEn: trimmed,
        phone: phone.trim() || null,
      });
      onChange(created);
      setCreating(false);
      setQuery('');
      setHits([]);
      toast.success(t('customers.created'), created.code);
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setSaving(false);
    }
  };

  // Debounced here rather than by the caller, so no screen can accidentally
  // search on every keystroke.
  const search = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    return (term: string) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        // Two characters is the point where results start to mean something;
        // below it every customer matches and the list is noise.
        if (term.trim().length < 2) {
          setHits([]);
          return;
        }
        try {
          setHits(
            await api.get<CustomerHit[]>(
              `/api/customers${queryString({ quick: true, search: term })}`,
            ),
          );
        } catch {
          setHits([]);
        }
      }, 250);
    };
  }, []);

  if (value) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-[var(--radius-control)] border border-primary-border bg-primary-subtle p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-content">{ln(value, 'fullName')}</p>
          <p className="font-mono text-xs text-content-secondary ltr-content">
            {value.code}
            {value.phone ? ` · ${value.phone}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 rounded p-1 text-content-tertiary hover:bg-surface-hover"
          aria-label={t('common.remove')}
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <>
      {/*
        No hint: it used to carry the same sentence as the placeholder, printed
        again directly under the field. One field, one instruction — and the
        placeholder is the copy worth keeping, because it sits where the eye
        already is.
      */}
      <Field label={label ?? t('common.search')} required={required} error={error}>
        {(props) => (
          <Input
            {...props}
            iconStart={<Search />}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              search(event.target.value);
            }}
            placeholder={t('customers.searchHint')}
          />
        )}
      </Field>

      {hits.length > 0 && (
        <ul className="divide-y divide-border-base overflow-hidden rounded-[var(--radius-control)] border border-border-base">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(hit);
                  setHits([]);
                  setQuery('');
                }}
                className="w-full px-3 py-2 text-start transition-colors hover:bg-surface-hover"
              >
                <span className="block truncate text-sm text-content">{ln(hit, 'fullName')}</span>
                <span className="block font-mono text-xs text-content-tertiary ltr-content">
                  {hit.code}
                  {hit.phone ? ` · ${hit.phone}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {permissions.includes('customers.create') && (
        <Button
          variant="ghost"
          size="sm"
          icon={<UserPlus />}
          onClick={openCreate}
        >
          {t('customers.new')}
        </Button>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('customers.new')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void create()}
              loading={saving}
              disabled={name.trim().length < 2}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('customers.fullName')} required>
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            )}
          </Field>

          <Field label={t('customers.phone')}>
            {(props) => (
              <Input
                {...props}
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            )}
          </Field>

          <p className="text-xs text-content-secondary">{t('customers.quickHint')}</p>
        </div>
      </Dialog>
    </>
  );
}
