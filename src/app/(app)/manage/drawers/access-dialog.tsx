'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldOff } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { Alert, Badge, Button } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Select, Switch } from '@/ui/form';

/**
 * Handing one person one drawer.
 *
 * ## Why a row per drawer rather than a list of people
 *
 * Because the question a manager actually has is "what can Ahmad reach?", not
 * "who can reach the shekel till". He picks the person once and then reads down
 * a single column of yes and no — which is also the shape of the mistake he is
 * trying to avoid, since the dangerous state is one person holding more than
 * intended rather than one drawer being widely held.
 *
 * ## Why each switch saves itself
 *
 * There is no Save button. A dialog that batches permission changes has a state
 * where the screen and the server disagree, and the manager cannot tell by
 * looking which one he is reading. Each toggle is one request and the row shows
 * the answer, so what is on screen is always what the server accepted.
 *
 * ## Why unticking everything removes the grant
 *
 * The row is the visibility: a person sees the drawers he has a row for. So a
 * grant with nothing ticked would mean "he can see this and do nothing with
 * it", which is never what unticking the last box was meant to say.
 */

interface DrawerRow {
  id: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  currencyCode: string;
}

interface Person {
  id: string;
  username: string;
  fullNameAr: string;
  fullNameEn: string;
  jobTitleAr: string | null;
  jobTitleEn: string | null;
}

interface Flags {
  canDeposit: boolean;
  canWithdraw: boolean;
  canTransfer: boolean;
}

type Granted = Record<string, Flags>;

/**
 * What to call a kind.
 *
 * Every one of the five, including the two the drawers screen's own helper
 * never learned — it answers "cash" for anything that is not the broker or the
 * correspondent, which would label the differences drawer as money on hand on a
 * screen whose whole job is deciding who may reach into it.
 */
function kindLabel(
  kind: string,
): 'drawers.cash' | 'drawers.broker' | 'drawers.correspondent' | 'drawers.difference' | 'drawers.receivable' {
  if (kind === 'BROKER') return 'drawers.broker';
  if (kind === 'CORRESPONDENT') return 'drawers.correspondent';
  if (kind === 'DIFFERENCE') return 'drawers.difference';
  if (kind === 'RECEIVABLE') return 'drawers.receivable';
  return 'drawers.cash';
}

const NONE: Flags = { canDeposit: false, canWithdraw: false, canTransfer: false };

export function AccessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const arabic = locale === 'ar';

  const [drawers, setDrawers] = useState<DrawerRow[]>([]);
  const [staff, setStaff] = useState<Person[]>([]);
  const [delegates, setDelegates] = useState<{ id: string; drawers: number }[]>([]);
  const [person, setPerson] = useState('');
  const [granted, setGranted] = useState<Granted>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const fail = useCallback(
    (caught: unknown) => {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    },
    [t, toast],
  );

  // The lists, once per opening. Drawers and staff do not change while a
  // permission dialog is open, and refetching them on every toggle would make
  // the switches feel slower than the decision behind them.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .get<{ drawers: DrawerRow[]; staff: Person[]; delegates: { id: string; drawers: number }[] }>(
        '/api/manage/drawers/grants',
      )
      .then((data) => {
        setDrawers(data.drawers);
        setStaff(data.staff);
        setDelegates(data.delegates);
      })
      .catch(fail)
      .finally(() => setLoading(false));
  }, [open, fail]);

  // What this person already holds, whenever the manager picks somebody.
  useEffect(() => {
    if (!person) {
      setGranted({});
      return;
    }
    setLoading(true);
    api
      .get<{ grants: ({ drawerId: string } & Flags)[] }>(
        `/api/manage/drawers/grants?userId=${encodeURIComponent(person)}`,
      )
      .then((data) => {
        const next: Granted = {};
        for (const grant of data.grants) {
          next[grant.drawerId] = {
            canDeposit: grant.canDeposit,
            canWithdraw: grant.canWithdraw,
            canTransfer: grant.canTransfer,
          };
        }
        setGranted(next);
      })
      .catch(fail)
      .finally(() => setLoading(false));
  }, [person, fail]);

  const toggle = async (drawer: DrawerRow, key: keyof Flags, value: boolean) => {
    const current = granted[drawer.id] ?? NONE;
    // Deposit and withdraw are always sent off: any left over from before they
    // stopped being delegable are cleared by the first toggle on the row.
    const next: Flags = { ...current, canDeposit: false, canWithdraw: false, [key]: value };

    setBusy(drawer.id);
    try {
      await api.post('/api/manage/drawers/grants', {
        userId: person,
        drawerId: drawer.id,
        ...next,
      });

      // Only after the server agreed. An optimistic switch on a permission
      // screen shows an access that may not exist.
      setGranted((held) => {
        const copy = { ...held };
        if (!next.canDeposit && !next.canWithdraw && !next.canTransfer) delete copy[drawer.id];
        else copy[drawer.id] = next;
        return copy;
      });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    setRevoking(false);
    setBusy('all');
    try {
      const { removed } = await api.delete<{ removed: number }>(
        `/api/manage/drawers/grants?userId=${encodeURIComponent(person)}`,
      );
      setGranted({});
      toast.success(t('drawerAccess.revoked'), String(removed));
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const held = Object.keys(granted).length;
  const chosen = staff.find((one) => one.id === person);

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('drawerAccess.title')} size="lg">
        <div className="space-y-4">
          <Alert tone="primary">{t('drawerAccess.explainer')}</Alert>

          <Field label={t('drawerAccess.person')}>
            {(props) => (
              <Select
                {...props}
                value={person}
                onChange={(event) => setPerson(event.target.value)}
                placeholder={t('drawerAccess.choose')}
                options={staff.map((one) => {
                  const name = arabic ? one.fullNameAr : one.fullNameEn;
                  const title = arabic ? one.jobTitleAr : one.jobTitleEn;
                  // How many drawers he already holds, beside his name: the
                  // manager picking from this list is usually looking for the
                  // person he gave something to and cannot remember which.
                  const count = delegates.find((entry) => entry.id === one.id)?.drawers ?? 0;
                  return {
                    value: one.id,
                    label:
                      name +
                      (title ? ` — ${title}` : '') +
                      (count > 0 ? ` (${count})` : ''),
                  };
                })}
              />
            )}
          </Field>

          {staff.length === 0 && !loading && (
            <Alert tone="warning">{t('drawerAccess.noStaff')}</Alert>
          )}

          {person && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-content-tertiary">
                    <th className="py-2 text-start font-medium">{t('drawerAccess.drawer')}</th>
                    {/* Transfer only. Putting money in or taking it out by hand
                        is the manager's alone, so it is not his to hand out. */}
                    <th className="px-2 py-2 text-center font-medium">
                      {t('drawerAccess.transfer')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drawers.map((drawer) => {
                    const flags = granted[drawer.id] ?? NONE;
                    const working = busy === drawer.id || busy === 'all';
                    return (
                      <tr key={drawer.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2">
                          <div className="font-medium text-content">
                            {arabic ? drawer.nameAr : drawer.nameEn}
                          </div>
                          <div className="text-xs text-content-tertiary">
                            {drawer.currencyCode} · {t(kindLabel(drawer.kind))}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <Switch
                            checked={flags.canTransfer}
                            disabled={working}
                            onCheckedChange={(value) => void toggle(drawer, 'canTransfer', value)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {person && (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <Badge tone={held > 0 ? 'primary' : 'neutral'}>
                {t('drawerAccess.holds', { count: String(held) })}
              </Badge>
              {held > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<ShieldOff />}
                  disabled={busy !== null}
                  onClick={() => setRevoking(true)}
                >
                  {t('drawerAccess.revokeAll')}
                </Button>
              )}
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        onConfirm={() => void revokeAll()}
        title={t('drawerAccess.revokeAll')}
        message={t('drawerAccess.revokeConfirm', {
          name: chosen ? (arabic ? chosen.fullNameAr : chosen.fullNameEn) : '',
        })}
        confirmLabel={t('drawerAccess.revokeAll')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />
    </>
  );
}

/** The button that opens it, so the drawers screen only imports one thing. */
export function AccessButton() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" icon={<KeyRound />} onClick={() => setOpen(true)}>
        {t('drawerAccess.title')}
      </Button>
      <AccessDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
