'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Button } from '@/ui/primitives';
import { Field, Input } from '@/ui/form';
import { normalizeDigits } from '@/core/money/money';

export function TwoFactorForm() {
  const { t } = useLocale();
  const router = useRouter();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (value: string) => {
    setError(null);
    setSubmitting(true);

    try {
      const result = await api.post<{ redirect: string }>('/api/auth/two-factor', { code: value });
      router.push(result.redirect);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('errors.generic'),
      );
      setSubmitting(false);
      setCode('');
    }
  };

  const onChange = (raw: string) => {
    // Accept Arabic-Indic digits from an Arabic keyboard.
    const digits = normalizeDigits(raw).replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    // Auto-submit on the sixth digit — nobody wants to reach for Enter here.
    if (digits.length === 6 && !submitting) void submit(digits);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(code);
      }}
      className="space-y-4"
      noValidate
    >
      {error && (
        <Alert tone="danger" icon={<AlertTriangle />}>
          {error}
        </Alert>
      )}

      <Field label={t('auth.twoFactorCode')} required>
        {(props) => (
          <Input
            {...props}
            value={code}
            onChange={(event) => onChange(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            dir="ltr"
            maxLength={6}
            className="text-center text-lg tracking-[0.5em] tabular-nums"
          />
        )}
      </Field>

      <Button
        type="submit"
        variant="primary"
        fullWidth
        size="lg"
        loading={submitting}
        disabled={code.length !== 6}
        icon={<ShieldCheck />}
      >
        {t('auth.verify')}
      </Button>
    </form>
  );
}
