'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Save } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { NAV_ICONS } from '@/app/_shell/icons';
import { NAVIGATION } from '@/app/_shell/navigation';
import { cn } from '@/ui/utils';

/**
 * Each menu the tellers see, shown or hidden with a press.
 *
 * Hidden, it leaves the tellers' sidebar, their search and their shortcuts, and
 * its page tells a teller who types its address that it is not theirs. The
 * supervisor and the manager keep every menu whatever is chosen here.
 */
export function TellerMenus({
  sections,
  hidden: initial,
}: {
  sections: { labelKey: string; items: { href: string; labelKey: string }[] }[];
  hidden: string[];
}) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();
  const [hidden, setHidden] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const changed =
    hidden.length !== initial.length || hidden.some((href) => !initial.includes(href));

  const iconOf = (href: string) => {
    for (const section of NAVIGATION) {
      const item = section.items.find((entry) => entry.href === href);
      if (item) return NAV_ICONS[item.icon];
    }
    return null;
  };

  const toggle = (href: string) =>
    setHidden((current) =>
      current.includes(href) ? current.filter((entry) => entry !== href) : [...current, href],
    );

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/teller-menus', { hidden });
      toast.success(t('tellerMenus.saved'));
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const total = sections.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <p className="text-sm text-content-secondary">
          {t('tellerMenus.summary', { shown: total - hidden.length, hidden: hidden.length })}
        </p>
        <Button variant="primary" icon={<Save />} loading={busy} disabled={!changed} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </div>

      {sections.map((section) => (
        <Card key={section.labelKey} className="overflow-hidden p-0">
          <p className="border-b border-border-subtle px-4 py-2 text-xs font-semibold text-content-tertiary">
            {t(section.labelKey as never)}
          </p>
          <ul className="divide-y divide-border-subtle">
            {section.items.map((item) => {
              const off = hidden.includes(item.href);
              const Icon = iconOf(item.href);
              return (
                <li key={item.href}>
                  <button
                    type="button"
                    onClick={() => toggle(item.href)}
                    aria-pressed={!off}
                    className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-surface-sunken"
                  >
                    <span
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-xl',
                        off ? 'bg-surface-sunken text-content-tertiary' : 'bg-primary-subtle text-primary-text',
                      )}
                    >
                      {Icon && <Icon className="size-4" />}
                    </span>
                    <span className={cn('flex-1 text-sm font-medium', off ? 'text-content-tertiary line-through' : 'text-content')}>
                      {t(item.labelKey as never)}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                        off ? 'bg-danger-subtle text-danger-text' : 'bg-success-subtle text-success-text',
                      )}
                    >
                      {off ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      {off ? t('tellerMenus.hidden') : t('tellerMenus.shown')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
