'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Badge, Button, Card, CardBody } from '@/ui/primitives';
import { DateText } from '@/ui/display';
import { TillRecordDialog, useVerdict } from '../../treasury/counts/till-record';

interface MyCount {
  id: string;
  reference: string;
  countedBy: { fullNameEn: string; fullNameAr: string };
  createdAt: string;
  lines: { currency: string; difference: string }[];
}

/** The teller's counts, newest first, each opening to its full record. */
export function MyCountsView({ currencies }: { currencies: { code: string; decimals: number }[] }) {
  const { t, ln } = useLocale();
  const decimalsOf = useCallback(
    (code: string) => currencies.find((currency) => currency.code === code)?.decimals ?? 2,
    [currencies],
  );
  const verdict = useVerdict(decimalsOf);
  const [counts, setCounts] = useState<MyCount[] | null>(null);
  const [record, setRecord] = useState<string | null>(null);

  useEffect(() => {
    // The server answers a teller with their own counts and nobody else's.
    void api
      .get<{ recent: MyCount[] }>('/api/treasury/till-counts')
      .then((result) => setCounts(result.recent))
      .catch(() => setCounts([]));
  }, []);

  return (
    <Card>
      <CardBody>
        {counts === null ? (
          <p className="text-sm text-content-tertiary">{t('common.loading')}</p>
        ) : counts.length === 0 ? (
          <p className="text-sm text-content-tertiary">{t('till.none')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {counts.map((count) => (
              <li key={count.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                <div className="min-w-40">
                  <p className="font-medium">
                    <DateText value={count.createdAt} withTime />
                  </p>
                  <p className="text-xs text-content-tertiary">
                    <span className="font-mono ltr-content">{count.reference}</span> ·{' '}
                    {t('till.countedBy')} {ln(count.countedBy, 'fullName')}
                  </p>
                </div>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {count.lines.map((line) => {
                    const result = verdict(line.currency, line.difference);
                    return (
                      <Badge
                        key={line.currency}
                        tone={
                          result.tone === 'ok'
                            ? 'success'
                            : result.tone === 'short'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {line.currency}: {result.text}
                      </Badge>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<FileText />}
                  onClick={() => setRecord(count.id)}
                >
                  {t('till.record')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <TillRecordDialog id={record} onClose={() => setRecord(null)} decimalsOf={decimalsOf} />
    </Card>
  );
}
