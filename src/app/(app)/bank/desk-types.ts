/** What the bank desk's three columns share: one line of the list, and where it stands. */

export interface Origin {
  kind: 'system' | 'external';
  name: string | null;
  phone: string | null;
}

export interface Line {
  id: string;
  /** A deal's transfer, one asked for in the group, or a message of the group that is neither. */
  source?: 'deal' | 'group' | 'message' | 'tiktok';
  reference: string;
  /** PENDING_TRANSFER while it waits; POSTED once sent; REVERSED when cancelled; MESSAGE for a bare message. */
  status: string;
  kind: string;
  at: string;
  channel: string | null;
  account: string | null;
  name: string | null;
  phone: string | null;
  amount: string;
  currency: string;
  notes: string | null;
  by: string | null;
  sentAt: string | null;
  sentBy: string | null;
  /** Its message in the bank group, as the groups' panel kept it. */
  messageId?: string | null;
  /** Recorded in the system, or asked in the group from outside the office — and by whom. */
  origin?: Origin;
  /** Passed on by a person, or to a group that carries transfers out. */
  forwardedTo?: { group: string; at: string }[];
  /** A bare message: its words, whether it carried a file, and whether the bot reads a transfer in it. */
  text?: string;
  hasMedia?: boolean;
  readable?: boolean;
}

export interface Desk {
  /** The bank transfers group the list is drawn from; none set, every transfer. */
  group?: { id: string; name: string } | null;
  waiting: Line[];
  sent: Line[];
  /** Every transfer of the days asked for, sent or not. */
  range?: Line[] | null;
  /** The group's other messages, from outside the office. */
  others?: Line[];
}

export type LineState = 'waiting' | 'forwarded' | 'done' | 'reversed' | 'message';

/** Where a line stands: waiting, handed on to a group to carry out, sent, cancelled — or a bare message. */
export function stateOf(line: Line): LineState {
  if (line.source === 'message') return 'message';
  if (line.status === 'REVERSED') return 'reversed';
  if (line.status !== 'PENDING_TRANSFER' || line.sentAt) return 'done';
  return (line.forwardedTo?.length ?? 0) > 0 ? 'forwarded' : 'waiting';
}

/** The key a line is chosen by: the same id can be a deal's and a request's. */
export function keyOf(line: Pick<Line, 'id' | 'source'>): string {
  return `${line.source ?? 'deal'}:${line.id}`;
}

/** A stored amount (scaled by 1e8) as the bank's app takes it: "320", "12.5". */
export function plainFigure(scaled: string): string {
  const digits = scaled.replace(/^-/, '').padStart(9, '0');
  const whole = digits.slice(0, -8).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-8).replace(/0+$/, '').slice(0, 2);
  return fraction ? `${whole}.${fraction}` : whole;
}
