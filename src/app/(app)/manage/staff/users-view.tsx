'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, ShieldOff, Search, UserCheck } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Alert, Badge, Button, Card } from '@/ui/primitives';
import { Checkbox, Field, FormGrid, Input, Select } from '@/ui/form';
import { DataTable, type Column } from '@/ui/data-table';
import { DateText, StatusBadge } from '@/ui/display';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';

interface UserRow {
  id: string;
  username: string;
  email: string;
  employeeCode: string | null;
  fullNameEn: string;
  fullNameAr: string;
  jobTitleEn: string | null;
  jobTitleAr: string | null;
  status: string;
  lastLoginAt: string | null;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  branch: { id: string; nameEn: string; nameAr: string } | null;
  roles: { role: { key: string; nameEn: string; nameAr: string; level: number } }[];
}

interface ListResponse {
  rows: UserRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function UsersView({
  initial,
  roles,
  branches,
  permissions,
}: {
  initial: ListResponse;
  roles: { id: string; key: string; nameEn: string; nameAr: string; level: number }[];
  branches: { id: string; nameEn: string; nameAr: string }[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<ListResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    username: '',
    email: '',
    fullNameEn: '',
    fullNameAr: '',
    jobTitleEn: '',
    jobTitleAr: '',
    branchId: '',
    roleIds: [] as string[],
    locale: 'ar' as 'ar' | 'en',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ListResponse>(
        `/api/admin/users${queryString({ page, pageSize: 50, search })}`,
      );
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<{ id: string; temporaryPassword: string }>('/api/admin/users', {
        ...form,
        branchId: form.branchId || null,
        jobTitleEn: form.jobTitleEn || null,
        jobTitleAr: form.jobTitleAr || null,
      });

      setTemporaryPassword(result.temporaryPassword);
      setCreating(false);
      setForm({ ...form, username: '', email: '', fullNameEn: '', fullNameAr: '', roleIds: [] });
      void load();
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? t(caught.messageKey as never, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!resetting) return;
    setBusy(true);
    try {
      const result = await api.post<{ temporaryPassword: string }>(
        `/api/admin/users/${resetting.id}`,
        { action: 'resetPassword' },
      );
      setTemporaryPassword(result.temporaryPassword);
      setResetting(null);
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

  const setStatus = async (user: UserRow, status: 'ACTIVE' | 'SUSPENDED') => {
    try {
      await api.patch(`/api/admin/users/${user.id}`, { status });
      toast.success(t('common.saved'), user.username);
      void load();
    } catch (caught) {
      toast.error(
        t('errors.title'),
        caught instanceof ApiError ? caught.message : t('errors.generic'),
      );
    }
  };

  const columns: Column<UserRow>[] = [
    {
      key: 'user',
      header: t('common.name'),
      cell: (row) => (
        <div>
          <p className="text-sm font-medium text-content">{ln(row, 'fullName')}</p>
          <p className="font-mono text-[10px] text-content-tertiary ltr-content">
            {row.username} · {row.email}
          </p>
        </div>
      ),
    },
    {
      key: 'roles',
      header: t('users.roles'),
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.roles.map((entry) => (
            <Badge key={entry.role.key} tone="primary">
              {ln(entry.role, 'name')}
            </Badge>
          ))}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'branch',
      header: t('common.branch'),
      cell: (row) => (row.branch ? ln(row.branch, 'name') : '—'),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <StatusBadge status={row.status} scope="users" />
          {row.twoFactorEnabled && <Badge tone="success">2FA</Badge>}
        </div>
      ),
    },
    {
      key: 'lastLogin',
      header: t('users.lastLogin'),
      align: 'end',
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          {row.lastLoginAt ? <DateText value={row.lastLoginAt} relative /> : t('common.never')}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          {permissions.includes('users.resetPassword') && (
            <Button
              variant="ghost"
              size="icon"
              title={t('users.resetPassword')}
              onClick={(event) => {
                event.stopPropagation();
                setResetting(row);
              }}
            >
              <KeyRound className="size-4" />
            </Button>
          )}
          {permissions.includes('users.update') && (
            <Button
              variant="ghost"
              size="icon"
              title={row.status === 'ACTIVE' ? t('users.suspend') : t('users.activate')}
              onClick={(event) => {
                event.stopPropagation();
                void setStatus(row, row.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE');
              }}
            >
              {row.status === 'ACTIVE' ? (
                <ShieldOff className="size-4" />
              ) : (
                <UserCheck className="size-4" />
              )}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row sm:items-center">
          <Input
            placeholder={t('common.searchPlaceholder')}
            iconStart={<Search />}
            defaultValue={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="sm:max-w-sm"
          />
          {permissions.includes('users.create') && (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus />}
              className="sm:ms-auto"
              onClick={() => setCreating(true)}
            >
              {t('users.new')}
            </Button>
          )}
        </div>

        <DataTable
          columns={columns}
          rows={data.rows}
          rowKey={(row) => row.id}
          loading={loading}
          emptyTitle={t('users.noUsers')}
          pagination={{
            page: data.page,
            pageSize: data.pageSize,
            total: data.total,
            pageCount: data.pageCount,
            onPageChange: setPage,
          }}
        />
      </Card>

      {/* --- Create ------------------------------------------------------ */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('users.new')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={
                !form.username || !form.email || !form.fullNameEn || !form.fullNameAr ||
                form.roleIds.length === 0
              }
              onClick={() => void create()}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <FormGrid columns={2}>
            <Field label={t('users.username')} required>
              {(props) => (
                <Input
                  {...props}
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
            <Field label={t('users.email')} required>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('users.fullNameAr')} required>
              {(props) => (
                <Input
                  {...props}
                  value={form.fullNameAr}
                  onChange={(event) => setForm({ ...form, fullNameAr: event.target.value })}
                  dir="rtl"
                />
              )}
            </Field>
            <Field label={t('users.fullNameEn')} required>
              {(props) => (
                <Input
                  {...props}
                  value={form.fullNameEn}
                  onChange={(event) => setForm({ ...form, fullNameEn: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('users.jobTitleAr')}>
              {(props) => (
                <Input
                  {...props}
                  value={form.jobTitleAr}
                  onChange={(event) => setForm({ ...form, jobTitleAr: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.branch')}>
              {(props) => (
                <Select
                  {...props}
                  options={[
                    { value: '', label: t('common.none') },
                    ...branches.map((branch) => ({ value: branch.id, label: ln(branch, 'name') })),
                  ]}
                  value={form.branchId}
                  onChange={(event) => setForm({ ...form, branchId: event.target.value })}
                />
              )}
            </Field>
          </FormGrid>

          <div>
            <p className="mb-2 text-xs font-medium text-content">
              {t('users.roles')} <span className="text-danger-text">*</span>
            </p>
            <div className="space-y-2">
              {roles.map((role) => (
                <Checkbox
                  key={role.id}
                  checked={form.roleIds.includes(role.id)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      roleIds: event.target.checked
                        ? [...form.roleIds, role.id]
                        : form.roleIds.filter((id) => id !== role.id),
                    })
                  }
                  label={ln(role, 'name')}
                  description={role.key}
                />
              ))}
            </div>
          </div>
        </div>
      </Dialog>

      {/* --- Reset password ----------------------------------------------- */}
      <ConfirmDialog
        open={resetting !== null}
        onClose={() => setResetting(null)}
        onConfirm={() => void resetPassword()}
        title={t('users.resetPassword')}
        message={
          resetting ? t('users.resetPasswordConfirm', { name: ln(resetting, 'fullName') }) : ''
        }
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      />

      {/* --- Temporary password ------------------------------------------- */}
      <Dialog
        open={temporaryPassword !== null}
        onClose={() => setTemporaryPassword(null)}
        title={t('users.temporaryPassword')}
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setTemporaryPassword(null)}>
            {t('common.ok')}
          </Button>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning">{t('users.temporaryPasswordHint')}</Alert>
          <div className="rounded-[var(--radius-control)] border border-border-base bg-surface-sunken p-3 text-center">
            <code className="select-all font-mono text-lg tracking-wider text-content ltr-content">
              {temporaryPassword}
            </code>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
