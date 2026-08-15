'use client';

import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { DateText } from '@/ui/display';
import { ENROLLED_MARKER, browserErrorName } from '@/app/(auth)/login/login-form';

/**
 * Turning the fingerprint on, for this device.
 *
 * Enrolment lives inside the account rather than on the sign-in screen, because
 * adding a way in is as consequential as changing the password and should
 * require already being in.
 *
 * The list is per device, and named by the person: one key belongs to the phone
 * in their pocket and another to the counter machine, and a year from now the
 * only way to know which is which is that they said so at the time.
 */

interface Passkey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

export function ProfileBiometrics() {
  const { t } = useLocale();
  const toast = useToast();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await api.get<Passkey[]>('/api/me/passkeys'));
    } catch {
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { platformAuthenticatorIsAvailable } = await import('@simplewebauthn/browser');
        setSupported(await platformAuthenticatorIsAvailable());
      } catch {
        setSupported(false);
      }
    })();
    void load();
  }, [load]);

  const enrol = async () => {
    setBusy(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');

      const { challengeId, options } = await api.post<{ challengeId: string; options: never }>(
        '/api/me/passkeys',
        { step: 'options' },
      );

      const response = await startRegistration({ optionsJSON: options });

      await api.post('/api/me/passkeys', {
        step: 'verify',
        challengeId,
        response,
        label: label.trim(),
      });

      // Remembered on this device so the sign-in screen can tell a person who
      // cancelled the prompt from one whose device holds no key at all.
      window.localStorage.setItem(ENROLLED_MARKER, '1');

      toast.success(t('auth.biometricsAdded'));
      setAdding(false);
      setLabel('');
      void load();
    } catch (caught) {
      // Dismissing the system prompt is a decision, not a failure. The name has
      // to be unwrapped from the library's own error — see `browserErrorName`.
      const name = browserErrorName(caught);
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setBusy(false);
        return;
      }
      if (name === 'InvalidStateError') {
        // The authenticator already holds a key for this account: it was
        // enrolled here before, and saying so beats a generic refusal.
        toast.error(t('errors.title'), t('auth.biometricsAlready'));
        setBusy(false);
        return;
      }
      toast.error(
        t('errors.title'),
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('auth.biometricFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/me/passkeys${queryString({ id: removing.id })}`);
      // The marker is per device and the list is per account, so it is only
      // safe to forget once nothing is left registered anywhere.
      if (keys.length <= 1) window.localStorage.removeItem(ENROLLED_MARKER);

      toast.success(t('auth.biometricsRemoved'), removing.label);
      setRemoving(null);
      void load();
    } catch (caught) {
      toast.error(
        t('errors.title'),
        caught instanceof ApiError ? caught.message : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('auth.biometrics')}
        description={t('auth.biometricsHint')}
        actions={
          supported && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Fingerprint />}
              onClick={() => {
                setLabel('');
                setAdding(true);
              }}
            >
              {t('auth.biometricsAdd')}
            </Button>
          )
        }
      />

      <CardBody className="space-y-3">
        {supported === false && <Alert tone="neutral">{t('auth.biometricsUnsupported')}</Alert>}

        {keys.length === 0 ? (
          <p className="text-sm text-content-tertiary">{t('auth.biometricsNone')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <Fingerprint className="size-4 shrink-0 text-content-tertiary" />
                <span className="text-sm font-medium text-content">{key.label}</span>

                {/* A synced key exists on the person's other devices too, which
                    changes what removing it here does and does not do. */}
                {key.backedUp && <Badge tone="neutral">{t('auth.biometricsSynced')}</Badge>}

                <span className="ms-auto text-xs text-content-tertiary">
                  {t('auth.biometricsLastUsed')}{' '}
                  {key.lastUsedAt ? (
                    <DateText value={key.lastUsedAt} withTime />
                  ) : (
                    t('auth.biometricsNeverUsed')
                  )}
                </span>

                <button
                  type="button"
                  onClick={() => setRemoving(key)}
                  aria-label={t('auth.biometricsRemove')}
                  title={t('auth.biometricsRemove')}
                  className="flex size-9 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-danger-subtle hover:text-danger-text"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('auth.biometricsAdd')}
        description={t('auth.biometricsHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<Fingerprint />}
              loading={busy}
              disabled={!label.trim()}
              onClick={() => void enrol()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('auth.biometricsDeviceName')} hint={t('auth.biometricsDeviceNameHint')} required>
          {(props) => (
            <Input {...props} value={label} onChange={(event) => setLabel(event.target.value)} />
          )}
        </Field>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={`${t('auth.biometricsRemove')} — ${removing?.label ?? ''}`}
        message={t('auth.biometricsRemoveConfirm')}
        confirmLabel={t('auth.biometricsRemove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      />
    </Card>
  );
}
