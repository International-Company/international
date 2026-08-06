# IFMS — International Financial Management System

A bilingual (Arabic / English) enterprise platform for currency exchange and
treasury operations: double-entry ledger, approval workflow, on-chain USDT
monitoring, immutable audit trail, and a daily open/close cycle.

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit AUTH_SECRET
npm run setup             # generate client + create schema + seed
npm run dev               # http://localhost:3000
```

`npm run setup` prints the seeded sign-in accounts. Every one of them is flagged
**must change password on first sign-in**.

| Username  | Role    | Permissions | Sees                                                        |
| --------- | ------- | ----------- | ----------------------------------------------------------- |
| `admin`   | Manager | 58 / 58     | Everything — approvals, rates, daily close, users, settings |
| `teller`  | Teller  | 17          | Own transactions, customers, rate board                     |

> These are development credentials. Change them and set a strong `AUTH_SECRET`
> before any real use.

### Two roles, deliberately

The system ships exactly two: a **manager** who supervises, and a **teller** who
operates. That is what makes the approval workflow mean anything — the teller
records a transaction, the manager approves it, so no one person both creates
and authorises a movement of money.

The teller cannot approve, reverse, publish a rate, close the day, or see
another teller's transactions. Intermediate roles were removed rather than kept
"just in case": each one blurs that line without adding capability, since the
manager already holds every permission.

The permission catalogue is still complete (58 entries), so a bespoke role can
be created under *Administration → Roles* without touching code.

**One consequence worth knowing:** approval is disabled for the person who
created the transaction. If the manager records a transaction above the approval
threshold themselves, nobody can approve it. Either let the teller enter it, add
a second manager account, or turn on *Settings → Approvals → Allow self-approval*
— which trades that control away.

### Scripts

| Command             | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Development server                               |
| `npm run build`     | Production build (runs `prisma generate` first)  |
| `npm start`         | Production server                                |
| `npm run typecheck` | `tsc --noEmit`                                   |
| `npm test`          | Unit tests (money arithmetic, audit chain)       |
| `npm run db:seed`   | Re-run the seeder (idempotent)                   |
| `npm run db:studio` | Prisma Studio                                    |

---

## The decisions that shaped this

### Money is never a float

Every monetary value — balances, amounts, rates, fees — is a `bigint` of minor
units scaled by **1e8**. `0.1 + 0.2` must equal `0.3` at a counter that
reconciles to the agora every evening, and in IEEE-754 it does not.

```
1.00 USD        -> 100_000_000n
0.00000001 USDT ->           1n
```

Eight decimal places covers fiat (2–3 dp) and USDT (6 dp) with headroom.
`src/core/money/money.ts` holds the arithmetic, with explicit rounding policies
(`half-up`, `half-even`, `up`, `down`) — no call site rounds implicitly.

### Only the ledger moves a balance

`src/modules/ledger/ledger.service.ts` is the sole writer of `accounts.balance`.
Every financial fact becomes a balanced journal entry, and entries are
append-only: a mistake is corrected by posting its mirror image, never by
editing history.

Multi-currency entries balance **per currency**. An exchange is two
single-currency postings joined through per-currency clearing accounts, because
adding shekels to dollars produces a number that means nothing.

`reconcile()` re-derives every cached balance from its journal lines and runs
hourly as a scheduled job. A non-empty result is a genuine incident.

### The audit trail is tamper-evident, not just append-only

Each record stores the SHA-256 of the one before it:

```
hash(n) = SHA256( hash(n-1) || canonical(record n) )
```

Editing, deleting or reordering any historical row breaks every subsequent link,
and `verifyChain()` reports exactly where. This holds even against someone with
direct database access — which is the property auditors actually ask for.

Canonical serialisation (sorted keys, bigint→string, ISO dates) is what makes
the hash reproducible; it is unit-tested in `tests/audit-chain.test.ts`.

### Authorisation fails closed

Permissions are declared once in `src/core/security/permissions.ts` and consumed
by the seeder, the API guards, the navigation filter and the admin matrix. A
capability is added in one place.

- Effective rights = union of role permissions **+** direct grants **−** direct denials. **DENY always wins.**
- A user may only manage accounts and roles *below* their own authority level.
- An administrator cannot grant a permission they do not themselves hold — that would be privilege escalation by proxy.
- Changing a password, role or permission **revokes existing sessions**, so a revoked right takes effect immediately rather than at next sign-out.
- When no exchange rate exists to evaluate the approval threshold, the transaction is routed for approval rather than waved through.

### Approval is segregation of duties, not a formality

Transactions at or above the configured threshold require a second signature,
and by default a user cannot approve their own work. Approval and posting are
one authorisation step — approving *is* the decision; posting is its mechanical
consequence.

### The daily close reconciles to physical cash

The operator counts each drawer; the system compares against the ledger and
posts any variance to a cash-difference account. Absorbing a shortage silently
would leave the books internally consistent but wrong — which is the exact
failure a daily close exists to catch. An uncounted drawer is recorded as
matching, never as empty.

The day cannot close while transactions are awaiting approval, and nothing can
post into a closed day.

### On-chain money enters through one door

A confirmed USDT transfer creates a **draft** internal transaction and notifies
whoever can act. It is never posted automatically: the chain proves money moved,
it does not prove whose it is, and posting a receipt to the wrong customer costs
far more to unwind than ten seconds of confirmation.

Blockchain access sits behind a provider interface
(`src/modules/usdt/providers/`) with TRON and Ethereum adapters and a **manual**
provider that is the default — the module works with no API keys, and stays
usable when an explorer is down or rate-limited.

---

## Bilingual by construction

Arabic is the primary operational language; English is an equivalent, not a
fallback.

- **No hard-coded strings.** The English dictionary defines the `Dictionary` type, so every other locale is checked against it at compile time — a missing or misspelled key is a build error, not a blank label discovered mid-transaction.
- **Direction is derived, never set by hand.** `lang`/`dir` resolve on the server from the locale cookie, so the first paint is already correct; switching language re-renders in place with no reload.
- **Layout uses logical CSS properties** (`inset-inline-start`, `ps-`, `me-`), so there is no RTL-specific stylesheet anywhere.
- **Latin digits in both locales.** Staff reconcile against bank statements, blockchain explorers and printed receipts that all use Latin digits; mixing numeral systems is how a ٧ gets read as a V. Everything else — month names, ordering, relative time — follows the locale.
- **Amounts, references, hashes and addresses are LTR-isolated** so a minus sign or transaction hash never renders reversed inside Arabic text.
- **Input accepts Arabic-Indic digits** (`٣٥٠٫٧٥` → `350.75`) because that is what an Arabic keyboard produces.

Receipts are printed as HTML by the browser rather than generated server-side:
Arabic needs bidirectional text and contextual letter shaping, which the
browser's text engine does correctly and most PDF libraries mangle.

## Theme

Semantic tokens only — components reference a *role* (`surface`, `border`,
`danger`), never a hex value, which is what lets the whole system re-theme
without touching a component.

Light and dark are separately calibrated (not an automatic inversion), plus a
`system` option that follows the OS live. An inline script applies the stored
choice **before first paint**, so a dark-themed workstation never flashes white.
A density switch resizes every table and control from one variable.

---

## Architecture

Modular monolith. One deployable, clear internal seams.

```
src/
  core/            # Kernel — no domain knowledge
    money/           exact decimal arithmetic
    db/              Prisma client + transaction composition
    http/            route wrapper: auth, validation, rate limit, errors
    security/        scrypt, AES-GCM, TOTP, permissions, rate limiting
    events/          in-process domain event bus
    jobs/            durable queue + scheduler + worker
    errors/ logger/ config/
  modules/         # Domain — each owns its data and rules
    auth/ users/ audit/ ledger/ exchange/ usdt/
    customers/ notifications/ reports/ settings/ backup/ dashboard/
  i18n/            # locales, provider, server helpers, formatting
  ui/              # design system (primitives, forms, overlays, tables)
  app/             # Next.js routes — thin; logic lives in modules
```

Modules communicate through the **event bus**, not direct imports: the exchange
module announces that a transaction was submitted and knows nothing about who
cares. Notification rules live entirely in
`src/modules/notifications/subscribers.ts`, so changing who is told about what
never touches financial code.

Every API endpoint is declared through `route()`, so authentication,
authorisation, validation, rate limiting, error shaping and logging are applied
uniformly instead of being re-implemented — and eventually forgotten — per route.

### Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Prisma · Tailwind v4 ·
Zod · Recharts

Security primitives use **Node's standard library only** — scrypt for passwords,
AES-256-GCM for stored secrets, HMAC-SHA1 for TOTP. No third-party crypto
dependency, and no native build step on any platform.

---

## Configuration

See `.env.example`. The essentials:

| Variable                 | Notes                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `DATABASE_URL`           | SQLite by default                                            |
| `AUTH_SECRET`            | **32+ chars.** Keys session signing and secret encryption.   |
| `SESSION_IDLE_MINUTES`   | Sliding idle timeout                                         |
| `SESSION_ABSOLUTE_HOURS` | Hard ceiling — never extended by activity                    |
| `JOBS_ENABLED`           | In-process background worker                                 |
| `TRON_API_KEY` / `ETH_API_KEY` | Optional. Blank ⇒ the manual provider is used.        |

Environment is validated with Zod at first import, so a misconfigured deployment
fails loudly at boot rather than subtly at runtime.

### Switching database engine

Point `DATABASE_URL` at the target and the provider follows automatically —
`scripts/prepare-db.mjs` derives it before every `prisma generate`, so you never
hand-edit `schema.prisma` or keep two copies in sync.

```
file:./dev.db                  -> sqlite      (local, zero setup)
postgresql://user:pass@host/db -> postgresql  (production)
```

**No model changes are required.** Enum-like columns are `String` with
Zod-enforced value sets, and JSON is stored as `String`, precisely so the schema
stays portable. Case-insensitive search is normalised across engines by
`src/core/db/search.ts` — PostgreSQL's `LIKE` is case-sensitive where SQLite's
is not, so without it a teller typing "ahmad" would find "Ahmad" locally and
nothing in production.

One caveat: `restoreBackup()` issues `PRAGMA defer_foreign_keys` and is
SQLite-specific. On PostgreSQL, restore from a `pg_dump` instead — backup
creation, verification and download work unchanged.

---

## Deploying to Railway

1. **Create the project** — *New Project → Deploy from GitHub repo* → this repository.
2. **Add PostgreSQL** — *New → Database → PostgreSQL*. Railway's own filesystem is wiped on every deploy, so an on-disk SQLite database would be destroyed each time you push.
3. **Set the variables** on the app service:

   | Variable        | Value                                                             |
   | --------------- | ----------------------------------------------------------------- |
   | `DATABASE_URL`  | `${{Postgres.DATABASE_URL}}` — references the database service     |
   | `AUTH_SECRET`   | 48 random bytes (see below). **Not optional.**                     |
   | `NODE_ENV`      | `production`                                                       |
   | `APP_URL`       | your Railway domain, e.g. `https://international.up.railway.app`   |
   | `ADMIN_PASSWORD`| *(optional)* — otherwise one is generated and printed once         |

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

4. **Deploy.** `railway.json` handles the rest: build, then `npm run deploy:start`, which applies the schema, seeds reference data and starts the server. Health checks hit `/api/health`.

5. **First sign-in.** Open the deploy log and find the administrator password — it is printed **once**. Sign in, change it immediately, then create real accounts under *Administration → Users*.

6. **Publish your rates.** Production is seeded with reference data only — no rates, no sample customers, no opening balances. Until you publish a rate under *Exchange → Rates*, pricing fails closed rather than trading against a placeholder someone forgot to replace.

### Before real money moves through it

- **HTTPS is mandatory.** Session cookies are `secure` in production, so over plain HTTP the cookie never comes back and nobody can sign in. Railway provides TLS by default — just don't disable it.
- **Set your opening balances** through a posted journal entry, not by editing the database.
- **Keep one replica.** The background worker, rate limiter and settings cache are in-process. To scale out, run the worker on one instance (`JOBS_ENABLED=false` elsewhere) and move the rate limiter to a shared store.
- **Backups**: `BACKUP_DIR` is ephemeral on Railway. Rely on Railway's managed Postgres backups, or attach a volume.

### Deployment notes

The background worker, the rate limiter and the settings cache are **in-process**
— correct for the single-server deployment an exchange office actually runs. Behind
a load balancer, replace the rate limiter with a shared store and run the worker
as one dedicated instance (`JOBS_ENABLED=false` elsewhere). Each is isolated
behind its own module for exactly that reason.

Session cookies are `httpOnly`, `sameSite=lax` and `secure` in production — so
production **must** be served over HTTPS or the cookie will not come back.

---

## Verified behaviour

Beyond `npm test`, the following were exercised end-to-end against a running
server: sign-in and lockout; rate publication and quoting; posting blocked
before the day is open; sub-threshold transactions posting straight through;
above-threshold routing to approval; self-approval refused; cross-user approval;
reversal leaving both entries visible; manual USDT transfer creating a linked
internal transaction; notifications reaching approvers; daily close posting a
deliberate 100 ILS shortage to the cash-difference account; posting into a
closed day blocked; trial balance balanced in all four currencies; ledger
reconciliation clean; audit chain verified intact; Excel export producing a
valid workbook.

## Known limitations

- **Two-factor authentication is implemented but not enrolled.** TOTP generation, verification, recovery-code storage and the login gate are all in place; the enrolment screen (QR display and confirmation) is not built, so `twoFactorEnabled` must currently be set directly.
- **Restore is SQLite-only** (see above).
- **PDF export** is via the browser's print dialog rather than server-side generation — deliberate, for Arabic shaping.
- **Wallet sync is polling**, not websocket-subscribed; the interval is configurable in settings.
