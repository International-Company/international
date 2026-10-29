'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardFooter, CardHeader } from '@/ui/primitives';
import { Checkbox, Field, Input, MoneyInput, NumberInput, Select } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { AppearanceSettings } from './appearance-settings';
import { MarketPanel } from './market-panel';
import { WhatsappPanel } from './whatsapp-panel';
import {
  SETTING_CATEGORIES,
  type SettingCategory,
  type SettingDefinition,
} from '@/modules/settings/settings.catalog';

type SettingWithValue = SettingDefinition & { value: unknown };

/**
 * Settings.
 *
 * The form is generated from the catalogue, so adding a setting to
 * `settings.catalog.ts` makes it appear here with the right control, labels and
 * validation — there is no per-setting UI code to keep in step.
 */
export function SettingsView({
  settings,
  canManage,
}: {
  settings: SettingWithValue[];
  canManage: boolean;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [category, setCategory] = useState<SettingCategory | 'appearance'>('appearance');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byCategory = useMemo(() => {
    const groups = new Map<SettingCategory, SettingWithValue[]>();
    for (const setting of settings) {
      const list = groups.get(setting.category) ?? [];
      list.push(setting);
      groups.set(setting.category, list);
    }
    return groups;
  }, [settings]);

  const dirty = Object.keys(draft).length > 0;

  const valueOf = (setting: SettingWithValue) =>
    draft[setting.key] !== undefined ? draft[setting.key] : setting.value;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.patch('/api/admin/settings', { values: draft });
      toast.success(t('common.saved'));
      setDraft({});
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setSaving(false);
    }
  };

  const renderControl = (setting: SettingWithValue) => {
    const value = valueOf(setting);
    const disabled = !canManage;

    switch (setting.type) {
      case 'boolean':
        return (
          <Checkbox
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [setting.key]: event.target.checked }))
            }
            label={t('common.enabled')}
          />
        );

      case 'number':
        return (
          <NumberInput
            value={String(value ?? '')}
            min={setting.min}
            max={setting.max}
            disabled={disabled}
            onValueChange={(next) => setDraft((current) => ({ ...current, [setting.key]: next }))}
          />
        );

      case 'money':
        return (
          <MoneyInput
            value={String(value ?? '')}
            disabled={disabled}
            onValueChange={(next) => setDraft((current) => ({ ...current, [setting.key]: next }))}
          />
        );

      case 'select':
        return (
          <Select
            options={(setting.options ?? []).map((option) => ({
              value: option.value,
              label: ln(option, 'label'),
            }))}
            value={String(value ?? '')}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [setting.key]: event.target.value }))
            }
          />
        );

      default:
        return (
          <Input
            value={String(value ?? '')}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [setting.key]: event.target.value }))
            }
          />
        );
    }
  };

  const tabs: { id: SettingCategory | 'appearance'; label: string }[] = [
    { id: 'appearance', label: t('settings.appearance') },
    ...SETTING_CATEGORIES.map((id) => ({
      id,
      label: t(`settings.category.${id}` as never),
    })),
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <nav className="lg:col-span-1">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                onClick={() => setCategory(tab.id)}
                className={cn(
                  'w-full whitespace-nowrap rounded-[var(--radius-control)] px-3 py-2 text-start text-sm transition-colors',
                  category === tab.id
                    ? 'bg-primary-subtle font-medium text-primary-text'
                    : 'text-content-secondary hover:bg-surface-hover',
                )}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="lg:col-span-3">
        {category === 'appearance' ? (
          <AppearanceSettings />
        ) : (
          <Card>
            <CardHeader
              title={t(`settings.category.${category}` as never)}
              actions={dirty && <Badge tone="warning">{t('settings.unsavedChanges')}</Badge>}
            />
            <CardBody className="space-y-5">
              {error && <Alert tone="danger">{error}</Alert>}

              {/*
                What the settings above actually produced. A manager editing the
                pair list should see the result without walking to another
                screen to squint at a moving strip.
              */}
              {category === 'machine' && <MarketPanel />}
              {category === 'whatsapp' && <WhatsappPanel canManage={canManage} />}

              {(byCategory.get(category) ?? [])
                .filter((setting) => !setting.hidden)
                .map((setting) => (
                  <div key={setting.key}>
                    {/*
                    In the language the person is reading the rest of the screen
                    in. Every setting carries both, and the catalogue is the only
                    place either is written — so this is the one line that had to
                    stop choosing English for an Arabic reader.
                  */}
                    <Field
                      label={
                        <span className="flex items-center gap-2">
                          {ln(setting, 'label')}
                          {setting.isSensitive && (
                            <Badge tone="warning">{t('roles.sensitive')}</Badge>
                          )}
                        </span>
                      }
                      hint={ln(setting, 'description')}
                    >
                      {() => renderControl(setting)}
                    </Field>
                  </div>
                ))}
            </CardBody>

            {canManage && (
              <CardFooter>
                <Button
                  variant="secondary"
                  disabled={!dirty || saving}
                  onClick={() => setDraft({})}
                >
                  {t('common.reset')}
                </Button>
                <Button
                  variant="primary"
                  icon={<Save />}
                  loading={saving}
                  disabled={!dirty}
                  onClick={() => void save()}
                >
                  {t('settings.saveChanges')}
                </Button>
              </CardFooter>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
