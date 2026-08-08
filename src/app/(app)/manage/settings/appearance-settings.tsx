'use client';

import { Languages, Monitor, Moon, Rows3, Sun } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { useTheme, type Density, type ThemePreference } from '@/ui/theme/provider';
import { Card, CardBody, CardHeader } from '@/ui/primitives';
import { cn } from '@/ui/utils';
import { LOCALE_META, LOCALES, type Locale } from '@/i18n/config';

/**
 * Per-user interface preferences.
 *
 * Every option applies the moment it is chosen — no save button, no reload.
 * The choice is written to a cookie for instant effect and to the user profile
 * so it follows them to another workstation.
 */
export function AppearanceSettings() {
  const { t, locale, setLocale } = useLocale();
  const { theme, setTheme, density, setDensity } = useTheme();

  const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: t('settings.themeLight'), icon: Sun },
    { value: 'dark', label: t('settings.themeDark'), icon: Moon },
    { value: 'system', label: t('settings.themeSystem'), icon: Monitor },
  ];

  const densityOptions: { value: Density; label: string }[] = [
    { value: 'comfortable', label: t('settings.densityComfortable') },
    { value: 'compact', label: t('settings.densityCompact') },
  ];

  return (
    <Card>
      <CardHeader title={t('settings.appearance')} />
      <CardBody className="space-y-6">
        {/* Language */}
        <section>
          <h3 className="flex items-center gap-2 text-sm font-medium text-content">
            <Languages className="size-4 text-content-tertiary" />
            {t('settings.language')}
          </h3>
          <p className="mt-0.5 text-xs text-content-secondary">{t('settings.languageHint')}</p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
            {LOCALES.map((code: Locale) => (
              <button
                key={code}
                type="button"
                onClick={() => setLocale(code)}
                aria-pressed={locale === code}
                className={cn(
                  'rounded-[var(--radius-control)] border p-3 text-start transition-colors',
                  locale === code
                    ? 'border-primary bg-primary-subtle'
                    : 'border-border-base hover:bg-surface-hover',
                )}
              >
                <span
                  className="block text-sm font-medium text-content"
                  dir={LOCALE_META[code].dir}
                >
                  {LOCALE_META[code].nativeName}
                </span>
                <span className="block text-xs text-content-tertiary">
                  {LOCALE_META[code].englishName} · {LOCALE_META[code].dir.toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Theme */}
        <section>
          <h3 className="flex items-center gap-2 text-sm font-medium text-content">
            <Sun className="size-4 text-content-tertiary" />
            {t('settings.theme')}
          </h3>

          <div className="mt-3 grid grid-cols-3 gap-2 sm:max-w-md">
            {themeOptions.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTheme(option.value)}
                  aria-pressed={theme === option.value}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-[var(--radius-control)] border p-3 transition-colors',
                    theme === option.value
                      ? 'border-primary bg-primary-subtle text-primary-text'
                      : 'border-border-base text-content-secondary hover:bg-surface-hover',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="text-xs font-medium">{option.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Density */}
        <section>
          <h3 className="flex items-center gap-2 text-sm font-medium text-content">
            <Rows3 className="size-4 text-content-tertiary" />
            {t('settings.density')}
          </h3>
          <p className="mt-0.5 text-xs text-content-secondary">{t('settings.densityHint')}</p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
            {densityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDensity(option.value)}
                aria-pressed={density === option.value}
                className={cn(
                  'rounded-[var(--radius-control)] border p-3 text-sm transition-colors',
                  density === option.value
                    ? 'border-primary bg-primary-subtle font-medium text-primary-text'
                    : 'border-border-base text-content-secondary hover:bg-surface-hover',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>
      </CardBody>
    </Card>
  );
}
