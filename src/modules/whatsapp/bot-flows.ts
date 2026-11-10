import { normalizeDigits } from '@/core/money/money';
import { emptyPick, renderAnswer, SAY_TO_STAFF } from './bot-answers';
import { firstMatch, isGreeting, type BotProfile, type FlowNode } from './bot-profile';
import { figureOf, findCountry, quoteCountry } from './country-prices';
import type { PriceSheet } from './price-sheet';
import { foldName } from './report-command';

/**
 * The conversations the manager drew: a tree of lists leading to answers.
 *
 * Walking it needs no assistant. A number or a name moves along a branch, so most
 * of a conversation costs nothing and can only ever say what is on the tree.
 */

/** Where a person is in the tree: the choices taken, by position. */
export interface FlowState {
  path: number[];
  /** Standing on an answer, with the list it came from still open. */
  atResult: boolean;
  at: number;
  /** Waiting to be told how much this country's beneficiary is to receive. */
  quote?: string | null;
}

export interface FlowStep {
  reply: string;
  state: FlowState | null;
  handover: boolean;
  summary: string | null;
}

/** A place left this long is forgotten: the person starts again from the top. */
export const FLOW_EXPIRES = 30 * 60 * 1000;

const BACK = '0. رجوع';
const STAFF = '#. موظف';
const SAY_PICK = 'اختر من القائمة:';

interface Context {
  profile: BotProfile;
  sheet: PriceSheet;
  open: boolean;
  now: number;
}

const blank: Omit<FlowNode, 'title' | 'kind'> = {
  text: '',
  triggers: [],
  currencies: [],
  channel: null,
  destination: null,
  accountIndex: null,
  children: [],
};

/** A list's choices. Two kinds are filled in from what the office already holds. */
export function childrenOf(node: FlowNode, ctx: Pick<Context, 'profile' | 'sheet'>): FlowNode[] {
  if (node.kind === 'destinations') {
    return [...new Set(ctx.sheet.remittances.map((row) => row.destination))].map((destination) => ({
      ...blank,
      title: destination,
      kind: 'remittance',
      destination,
    }));
  }
  if (node.kind === 'countries') {
    return ctx.profile.countryPrices.map((row) => ({
      ...blank,
      title: row.country,
      kind: 'country_quote',
      destination: row.country,
    }));
  }
  if (node.kind === 'accounts') {
    return ctx.profile.accounts.map((row, accountIndex) => ({
      ...blank,
      title: row.bank,
      kind: 'account',
      accountIndex,
    }));
  }
  return node.children;
}

const isList = (node: FlowNode) =>
  node.kind === 'menu' ||
  node.kind === 'destinations' ||
  node.kind === 'accounts' ||
  node.kind === 'countries';

const rootOf = (profile: BotProfile): FlowNode => ({
  ...blank,
  title: '',
  kind: 'menu',
  text: profile.flow.prompt,
  children: profile.flow.children,
});

function nodeAt(root: FlowNode, path: number[], ctx: Context): FlowNode | null {
  let node: FlowNode | undefined = root;
  for (const index of path) {
    node = node && childrenOf(node, ctx)[index];
  }
  return node ?? null;
}

function listText(node: FlowNode, depth: number, ctx: Context): string {
  const items = childrenOf(node, ctx).map((child, index) => `${index + 1}. ${child.title}`);
  return [
    node.text.trim() || SAY_PICK,
    ...items,
    '',
    depth > 0 ? `${BACK}   ${STAFF}` : STAFF,
  ].join('\n');
}

function showList(path: number[], root: FlowNode, ctx: Context, intro?: string): FlowStep | null {
  const node = nodeAt(root, path, ctx);
  if (!node) return null;
  const text = listText(node, path.length, ctx);
  return {
    reply: intro ? `${intro}\n\n${text}` : text,
    state: { path, atResult: false, at: ctx.now },
    handover: false,
    summary: null,
  };
}

const titlesOf = (root: FlowNode, path: number[], ctx: Context) => {
  const titles: string[] = [];
  let node: FlowNode | undefined = root;
  for (const index of path) {
    node = node && childrenOf(node, ctx)[index];
    if (node) titles.push(node.title);
  }
  return titles.join(' ← ');
};

const staffStep = (ctx: Context, path: number[], summary: string): FlowStep => {
  const answer = renderAnswer(
    emptyPick({ intent: 'handover', summary }),
    ctx.profile,
    ctx.sheet,
    ctx.open,
  );
  return {
    reply: answer.reply ?? SAY_TO_STAFF,
    state: { path, atResult: true, at: ctx.now },
    handover: true,
    summary,
  };
};

function resultOf(node: FlowNode, ctx: Context): string | null {
  const render = (over: Parameters<typeof emptyPick>[0]) =>
    renderAnswer(emptyPick(over), ctx.profile, ctx.sheet, ctx.open).reply;
  switch (node.kind) {
    case 'text':
      return node.text.trim() || null;
    case 'price':
      return render({ intent: 'price', currencies: node.currencies, channel: node.channel });
    case 'remittance':
      return render({ intent: 'remittance', destination: node.destination });
    case 'account':
      return render({ intent: 'account', account_index: node.accountIndex });
    default:
      return null;
  }
}

function open(root: FlowNode, path: number[], ctx: Context): FlowStep | null {
  const node = nodeAt(root, path, ctx);
  if (!node) return null;
  if (isList(node)) {
    // A list with nothing on it, such as no country priced yet, is a dead end: a person takes it.
    if (childrenOf(node, ctx).length === 0) {
      return staffStep(ctx, path.slice(0, -1), titlesOf(root, path, ctx));
    }
    return showList(path, root, ctx);
  }
  const parent = path.slice(0, -1);
  if (node.kind === 'country_quote') {
    const country = findCountry(ctx.profile.countryPrices, node.destination);
    if (!country) return staffStep(ctx, parent, titlesOf(root, path, ctx));
    return {
      reply: `كم بدك يوصل للمستفيد في ${country.country}؟ اكتب المبلغ بـ${country.unit}.\n\n${BACK}   ${STAFF}`,
      state: { path: parent, atResult: false, at: ctx.now, quote: country.country },
      handover: false,
      summary: null,
    };
  }
  if (node.kind === 'staff') return staffStep(ctx, parent, titlesOf(root, path, ctx));

  const body = resultOf(node, ctx);
  if (!body) {
    // A price since hidden or an empty answer: a person picks it up rather than a blank.
    return staffStep(ctx, parent, titlesOf(root, path, ctx));
  }
  return {
    reply: `${body}\n\n${BACK}   ${STAFF}`,
    state: { path: parent, atResult: true, at: ctx.now },
    handover: false,
    summary: null,
  };
}

function choiceFrom(text: string, children: FlowNode[]): number | null {
  if (/^\d{1,2}$/.test(text)) {
    const index = Number(text) - 1;
    return index >= 0 && index < children.length ? index : null;
  }
  const wanted = foldName(text);
  if (wanted.length < 2) return null;
  const exact = children.findIndex((child) => foldName(child.title) === wanted);
  if (exact >= 0) return exact;
  const partial = children.flatMap((child, index) =>
    foldName(child.title).includes(wanted) || wanted.includes(foldName(child.title)) ? [index] : [],
  );
  return partial.length === 1 ? partial[0]! : null;
}

export const hasFlows = (profile: BotProfile) => profile.flow.children.length > 0;

const quoteReply = (
  country: string,
  delivered: bigint,
  channel: 'CASH' | 'BANK' | null,
  ctx: Context,
) => {
  const row = findCountry(ctx.profile.countryPrices, country);
  return row ? quoteCountry(row, delivered, channel) : null;
};

/** A sum for a country, however it was asked; asks for the sum when it was not said. */
export function quoteStep(
  ask: {
    country: string;
    delivered: string | null;
    channel: 'CASH' | 'BANK' | null;
    wantsStaff?: boolean;
    summary?: string | null;
  },
  previous: FlowState | null,
  profile: BotProfile,
  sheet: PriceSheet,
  isOpen: boolean,
  now: number,
): FlowStep | null {
  const ctx: Context = { profile, sheet, open: isOpen, now };
  const country = findCountry(profile.countryPrices, ask.country);
  if (!country) return null;
  const path = previous?.path ?? [];
  const delivered = ask.delivered ? figureOf(ask.delivered) : null;
  if (!delivered) {
    return {
      reply: `كم بدك يوصل للمستفيد في ${country.country}؟ اكتب المبلغ بـ${country.unit}.`,
      state: { path, atResult: false, at: now, quote: country.country },
      handover: false,
      summary: null,
    };
  }
  const body = quoteCountry(country, delivered, ask.channel);
  if (!body)
    return staffStep(
      ctx,
      path,
      `${country.country}: ${figureText(ask.delivered!)} ${country.unit}`,
    );
  const staff = ask.wantsStaff ? staffStep(ctx, path, ask.summary ?? country.country) : null;
  return {
    reply: staff ? `${body}\n${staff.reply}` : `${body}\n\n${BACK}   ${STAFF}`,
    state: { path, atResult: true, at: now },
    handover: Boolean(staff),
    summary: staff?.summary ?? null,
  };
}

const figureText = (value: string) => value.trim();

/**
 * One message against the tree. Null when the tree has nothing to say to it, so
 * the assistant can be asked what it means.
 */
export function stepFlow(
  rawText: string,
  previous: FlowState | null,
  profile: BotProfile,
  sheet: PriceSheet,
  isOpen: boolean,
  now: number,
): FlowStep | null {
  const ctx: Context = { profile, sheet, open: isOpen, now };
  const root = rootOf(profile);
  const text = normalizeDigits(rawText).trim();
  const state = previous && now - previous.at < FLOW_EXPIRES ? previous : null;
  if (!hasFlows(profile) && !state?.quote) return null;

  if (state?.quote) {
    if (text === '#' || foldName(text) === 'موظف') {
      return staffStep(ctx, state.path, state.quote);
    }
    if (text === '0') {
      return hasFlows(profile) ? showList(state.path, root, ctx) : null;
    }
    const delivered = figureOf(text);
    if (delivered && delivered > 0n) {
      const body = quoteReply(state.quote, delivered, null, ctx);
      if (!body) return staffStep(ctx, state.path, `${state.quote}: ${text}`);
      return {
        reply: `${body}\n\n${BACK}   ${STAFF}`,
        state: { path: state.path, atResult: true, at: now },
        handover: false,
        summary: null,
      };
    }
  }

  if (isGreeting(text)) {
    return showList([], root, ctx, state ? undefined : profile.welcome.trim() || undefined);
  }

  if (state) {
    if (text === '#' || foldName(text) === 'موظف') {
      return staffStep(ctx, state.path, titlesOf(root, state.path, ctx) || text);
    }
    if (text === '0') {
      return showList(state.atResult ? state.path : state.path.slice(0, -1), root, ctx);
    }
    const here = nodeAt(root, state.path, ctx);
    if (here) {
      const choice = choiceFrom(text, childrenOf(here, ctx));
      if (choice !== null) return open(root, [...state.path, choice], ctx);
    }
  }

  const triggered = profile.flow.children.findIndex((child) => firstMatch(text, child.triggers));
  return triggered >= 0 ? open(root, [triggered], ctx) : null;
}

/** Opens one of the top choices, when the assistant has said that is what was meant. */
export function enterFlow(
  index: number,
  profile: BotProfile,
  sheet: PriceSheet,
  isOpen: boolean,
  now: number,
): FlowStep | null {
  if (!profile.flow.children[index]) return null;
  return open(rootOf(profile), [index], { profile, sheet, open: isOpen, now });
}

/** The list the person is on, or the main one: said when a message fits nothing. */
export function currentMenu(
  previous: FlowState | null,
  profile: BotProfile,
  sheet: PriceSheet,
  isOpen: boolean,
  now: number,
): FlowStep | null {
  if (!hasFlows(profile)) return null;
  const state = previous && now - previous.at < FLOW_EXPIRES ? previous : null;
  return showList(state?.path ?? [], rootOf(profile), { profile, sheet, open: isOpen, now });
}
