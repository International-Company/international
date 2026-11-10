'use client';

import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import {
  FLOW_KINDS,
  MAX_FLOW_CHOICES,
  MAX_FLOW_DEPTH,
  type FlowNode,
} from '@/modules/whatsapp/bot-profile';
import { Field, Input, Select, Textarea } from '@/ui/form';
import { Button } from '@/ui/primitives';

export const emptyNode = (): FlowNode => ({
  title: '',
  kind: 'text',
  text: '',
  triggers: [],
  currencies: [],
  channel: null,
  destination: null,
  accountIndex: null,
  children: [],
});

interface Options {
  currencies: string[];
  destinations: string[];
  accounts: string[];
  disabled: boolean;
}

function NodeEditor({
  node,
  depth,
  position,
  count,
  options,
  onChange,
  onRemove,
  onMove,
}: {
  node: FlowNode;
  depth: number;
  position: number;
  count: number;
  options: Options;
  onChange: (node: FlowNode) => void;
  onRemove: () => void;
  onMove: (by: number) => void;
}) {
  const { t } = useLocale();
  const { disabled } = options;
  const set = (patch: Partial<FlowNode>) => onChange({ ...node, ...patch });
  const canNest = depth < MAX_FLOW_DEPTH;
  const kinds = FLOW_KINDS.filter((kind) => kind !== 'menu' || canNest);

  return (
    <div className="space-y-3 rounded-xl bg-surface-sunken p-3 ring-1 ring-border-subtle">
      <div className="flex items-start gap-2">
        <span className="mt-8 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
          {position + 1}
        </span>
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
          <Field label={t('privateBot.flowTitle')}>
            {(props) => (
              <Input
                {...props}
                maxLength={60}
                disabled={disabled}
                placeholder={t('privateBot.flowTitleExample')}
                value={node.title}
                onChange={(event) => set({ title: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('privateBot.flowKind')}>
            {(props) => (
              <Select
                {...props}
                disabled={disabled}
                value={node.kind}
                onChange={(event) => set({ kind: event.target.value as FlowNode['kind'] })}
                options={kinds.map((kind) => ({
                  value: kind,
                  label: t(`privateBot.flowKinds.${kind}`),
                }))}
              />
            )}
          </Field>
        </div>
        {!disabled && (
          <div className="mt-6 flex shrink-0 items-center">
            <button
              type="button"
              aria-label={t('privateBot.flowUp')}
              disabled={position === 0}
              onClick={() => onMove(-1)}
              className="flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface disabled:opacity-30"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t('privateBot.flowDown')}
              disabled={position === count - 1}
              onClick={() => onMove(1)}
              className="flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface disabled:opacity-30"
            >
              <ChevronDown className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t('common.delete')}
              onClick={onRemove}
              className="flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface hover:text-danger-text"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        )}
      </div>

      {depth === 0 && (
        <Field label={t('privateBot.flowTriggers')} hint={t('privateBot.flowTriggersHint')}>
          {(props) => (
            <Input
              {...props}
              disabled={disabled}
              placeholder={t('privateBot.flowTriggersExample')}
              value={node.triggers.join('، ')}
              onChange={(event) =>
                set({
                  triggers: event.target.value.split(/[،,]/).map((entry) => entry.trimStart()),
                })
              }
            />
          )}
        </Field>
      )}

      {(node.kind === 'menu' || node.kind === 'destinations' || node.kind === 'accounts') && (
        <Field label={t('privateBot.flowQuestion')}>
          {(props) => (
            <Input
              {...props}
              maxLength={200}
              disabled={disabled}
              placeholder={t('privateBot.flowQuestionExample')}
              value={node.text}
              onChange={(event) => set({ text: event.target.value })}
            />
          )}
        </Field>
      )}

      {node.kind === 'text' && (
        <Field label={t('privateBot.flowAnswer')}>
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={1000}
              disabled={disabled}
              value={node.text}
              onChange={(event) => set({ text: event.target.value })}
            />
          )}
        </Field>
      )}

      {node.kind === 'price' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-medium text-content">
              {t('privateBot.flowCurrencies')}
            </p>
            <div className="flex flex-wrap gap-2">
              {[...options.currencies, 'USDT'].map((code) => {
                const on = node.currencies.includes(code);
                return (
                  <button
                    key={code}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        currencies: on
                          ? node.currencies.filter((item) => item !== code)
                          : [...node.currencies, code],
                      })
                    }
                    className={`h-9 rounded-full px-3 text-sm font-medium ${
                      on
                        ? 'bg-primary-subtle text-primary-text ring-1 ring-primary'
                        : 'bg-surface text-content-secondary'
                    }`}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label={t('privateBot.flowChannel')}>
            {(props) => (
              <Select
                {...props}
                disabled={disabled}
                value={node.channel ?? ''}
                onChange={(event) =>
                  set({ channel: (event.target.value || null) as FlowNode['channel'] })
                }
                options={[
                  { value: '', label: t('privateBot.flowChannelBoth') },
                  { value: 'CASH', label: t('privateBot.show.cash') },
                  { value: 'BANK', label: t('privateBot.show.bank') },
                ]}
              />
            )}
          </Field>
        </div>
      )}

      {node.kind === 'remittance' && (
        <Field label={t('privateBot.flowDestination')}>
          {(props) => (
            <Select
              {...props}
              disabled={disabled}
              value={node.destination ?? ''}
              onChange={(event) => set({ destination: event.target.value || null })}
              options={[
                { value: '', label: t('privateBot.flowAllDestinations') },
                ...options.destinations.map((value) => ({ value, label: value })),
              ]}
            />
          )}
        </Field>
      )}

      {node.kind === 'account' && (
        <Field label={t('privateBot.flowAccount')}>
          {(props) => (
            <Select
              {...props}
              disabled={disabled}
              value={node.accountIndex === null ? '' : String(node.accountIndex)}
              onChange={(event) =>
                set({ accountIndex: event.target.value === '' ? null : Number(event.target.value) })
              }
              options={[
                { value: '', label: t('privateBot.flowChooseAccount') },
                ...options.accounts.map((label, index) => ({ value: String(index), label })),
              ]}
            />
          )}
        </Field>
      )}

      {node.kind === 'menu' && (
        <div className="ms-3 border-s-2 border-border-subtle ps-3">
          <NodeList
            nodes={node.children}
            depth={depth + 1}
            options={options}
            onChange={(children) => set({ children })}
          />
        </div>
      )}
    </div>
  );
}

export function NodeList({
  nodes,
  depth,
  options,
  onChange,
}: {
  nodes: FlowNode[];
  depth: number;
  options: Options;
  onChange: (nodes: FlowNode[]) => void;
}) {
  const { t } = useLocale();
  const move = (from: number, by: number) => {
    const next = [...nodes];
    const [taken] = next.splice(from, 1);
    next.splice(from + by, 0, taken!);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {nodes.map((node, index) => (
        <NodeEditor
          key={index}
          node={node}
          depth={depth}
          position={index}
          count={nodes.length}
          options={options}
          onChange={(changed) => onChange(nodes.map((item, at) => (at === index ? changed : item)))}
          onRemove={() => onChange(nodes.filter((_, at) => at !== index))}
          onMove={(by) => move(index, by)}
        />
      ))}
      {!options.disabled && nodes.length < MAX_FLOW_CHOICES && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus />}
          onClick={() => onChange([...nodes, emptyNode()])}
        >
          {t('privateBot.flowAdd')}
        </Button>
      )}
    </div>
  );
}
