# Financial calculation & allocation specification

## 1. Units and conventions

- All amounts are **integer euro cents** (`Int` in the DB, `number` in TS, always `Number.isSafeInteger`). Floating-point is never used for money. Parsing user input (`"198,40"`, `"198.4"`) goes straight to cents.
- A **period** is a calendar month written `YYYY-MM`. All dates are interpreted in `Europe/Berlin`.
- Every ledger row belongs to exactly one **apartment** and, for resident-level rows, one **membership** (a resident's stay in the apartment). A person who leaves and returns gets a new membership.

## 2. Ledger entities

| Entity | Sign | Mutable? |
|---|---|---|
| **Charge** (obligation): membership, period, category, amount > 0, source rule, due date | increases what is owed | `DRAFT` charges can be edited or deleted. `FINAL` charges are immutable and can only be *voided* (status `VOID`, with reason and audit). |
| **Adjustment**: membership, period, category, signed amount, reason | `+` increases what is owed (e.g. operating-cost settlement). `−` decreases it (credit, waiver, Splitwise settlement). | immutable. A correction is a new, opposite adjustment. |
| **Payment** (transfer from resident to the apartment): amount > 0, transfer date, bank, description, evidence, status | — | Editable only while `DRAFT` / `CLARIFICATION_REQUESTED`. After `VERIFIED` it can only be `REVERSED`. |
| **Allocation**: payment → charge, amount > 0, state | reduces the charge's open amount | Created as `PROPOSED` (by the resident or the importer) and becomes `ACTIVE` on verification. Reallocation = mark `REVERSED` + create a new one. |
| **Refund / payout** (apartment → resident): amount > 0, category (deposit/credit) | reduces deposit held or unallocated credit | immutable. Reversal creates an opposite record. |

Categories: `RENT`, `ELECTRICITY`, `OPERATING_COSTS`, `SHARED_EXPENSE`, `SECURITY_DEPOSIT`, `RENT_BUFFER`, `OTHER`.
**Income categories** = everything except `SECURITY_DEPOSIT` and `RENT_BUFFER`. Those two are **held funds**: they count toward "deposit paid", never toward "rent collected".

## 3. Core formulas (`server/finance/ledger.ts`)

For one membership *m*, period *p*, category *c*:

```
charged(m,p,c)      = Σ amount of FINAL charges
adjusted(m,p,c)     = Σ signed amount of adjustments
confirmed(m,p,c)    = Σ ACTIVE allocations whose payment is VERIFIED, to FINAL charges of (m,p,c)
pending(m,p,c)      = Σ PROPOSED allocations whose payment is SUBMITTED | UNDER_REVIEW | CLARIFICATION_REQUESTED
due(m,p,c)          = charged + adjusted
outstanding(m,p,c)  = due − confirmed                                 (can be < 0 only through credit adjustments)
```

Totals are sums over (p, c). In particular:

```
opening balance            = an Adjustment with kind OPENING_BALANCE in the first ledger period (never invented; admin-entered)
outstanding to date(m)     = Σ_{p ≤ current, c ∈ income} outstanding(m,p,c)
unallocated credit(m)      = Σ VERIFIED payments − Σ ACTIVE allocations − Σ credit payouts
deposit held(m)            = Σ confirmed(m,·,{SECURITY_DEPOSIT,RENT_BUFFER}) − Σ deposit payouts
```

Rules enforced in code **and** tested:

1. Only `VERIFIED` payments with `ACTIVE` allocations reduce confirmed balances.
2. Pending submissions appear only in `pending` and never reduce `outstanding`.
3. Deposits use their own categories. A deposit can be applied to rent only through an explicit `DEPOSIT_APPLIED` operation, which creates a deposit payout and a matching rent credit adjustment, both audited.
4. Electricity is always its own category.
5. Multi-month payments must be allocated explicitly, one allocation per charge.
6. Partial allocation is allowed: an allocation may be smaller than the charge's open amount.
7. **Invariants checked inside the DB transaction**:
   - Σ ACTIVE allocations of a payment ≤ payment amount. The remainder is *unallocated credit*.
   - Σ ACTIVE allocations of a charge ≤ charge amount. Over-allocating is rejected, and the excess stays as credit.
   - An allocation's charge and payment belong to the same membership.
8. **Splitting** a total between residents uses the **largest-remainder method** with a deterministic tie-break (membership join date, then id). Σ shares = total, exactly to the cent. Percentage splits use basis points (Σ = 10 000).
9. **Reconciliation invariant**: for every period, Σ_m charged(m,p,·) equals the rule's apartment-wide total. The generator asserts this, and the report shows any differences.
10. Historical charges are never recomputed. Each charge stores `ruleId`, `ruleVersion`, `amount` and `effectiveFrom` as they were when generated.
11. Every void, reversal, reallocation, adjustment or payout writes an `AuditEvent` with before/after JSON, actor and reason.
12. Dashboards, statements, charts, reminders and exports all call `computeLedger()` / `summarize*()`. No component computes money itself.

## 4. Charge rules (price configuration)

A **ChargeRule** belongs to one category and has `effectiveFrom` (period, inclusive) and an optional `effectiveTo`. It is versioned: changing a price creates a *new* rule version and closes the previous one at `effectiveFrom − 1`. Rent and electricity have independent rules, so their effective dates can differ.

Allocation methods:

| Method | Inputs | Per-member amount |
|---|---|---|
| `EQUAL_SPLIT` | apartment total, optional member subset | largest-remainder split of total across active members |
| `FIXED_PER_MEMBER` | amount | same amount for every active member |
| `CUSTOM` | amount per membership | as entered (members without an entry pay 0) |
| `PERCENTAGE` | apartment total + basis points per membership (Σ = 10 000) | largest-remainder split by weight |

A member is **active in period p** when `billingStart ≤ p ≤ billingEnd` (`billingEnd` empty = still living there). Those are explicit periods on the membership, derived by default from move-in/move-out dates (a member who moves in after the 15th starts billing the next month) and editable by the admin. Pro-rating, if wanted, is done with a `CUSTOM` rule for that month or with an adjustment.

## 5. Obligation generation

`generatePeriod(apartment, p)` collects every rule effective in *p* plus every member active in *p*, and creates `DRAFT` charges using an idempotent upsert keyed by (membership, period, category, ruleId).
The admin reviews the draft table (per member × category, with totals and a reconciliation check). **Finalize** sets them to `FINAL` and sets the period's due date. Regenerating a period only replaces `DRAFT` charges. Final charges are never touched.
One-off charges (deposit, rent buffer, operating-cost settlement) are created manually as charges on a chosen period.

## 6. Payment lifecycle

```
DRAFT → SUBMITTED → UNDER_REVIEW → VERIFIED → (REVERSED)
                  ↘ CLARIFICATION_REQUESTED → SUBMITTED
                  ↘ REJECTED
```

- Resident submits: amount, transfer date, bank, description, intended periods, evidence. The system proposes allocations oldest-first across the selected periods (resident can adjust).
- Admin verifies: confirms or edits the allocations (Σ ≤ amount). Everything happens in one transaction: status → `VERIFIED`, allocations → `ACTIVE`, audit event, notification outbox rows.
- An admin cannot verify a payment that belongs to their own membership unless another admin exists… *open question*. By default, an admin may record **their own** share as `SELF_SETTLED`, which is audited and shown with that label.
- Reversal: status → `REVERSED`, all its allocations → `REVERSED`, reason required.

## 7. Overdue & status per member-period

```
status = PAID            if outstanding ≤ 0
       = PENDING         if outstanding > 0 and outstanding − pending ≤ 0
       = OVERDUE         if outstanding > 0 and today > dueDate + graceDays
       = PARTIAL         if confirmed > 0
       = DUE             otherwise
```

## 8. Collection chart (per period)

- **expected** = Σ due over income categories (FINAL charges + adjustments)
- **confirmed** = Σ confirmed over income categories (each allocation counted once, so a multi-month transfer is never double counted)
- **pending** = Σ pending over income categories
- **outstanding** = expected − confirmed
- Rejected payments are listed as a count, never as an amount.

## 9. Historical import

1. Upload .xlsx → `ImportBatch` (SHA‑256 of the file. Re-importing the same hash requires an explicit "import again" confirmation).
2. Each row → `ImportRow` with raw JSON, normalised fields and `issues[]`: `UNKNOWN_RESIDENT`, `AMBIGUOUS_RESIDENT`, `MISSING_AMOUNT`, `FORMULA_AMOUNT`, `YEAR_INFERRED`, `DATE_INCONSISTENT`, `POSSIBLE_DUPLICATE` (within the batch or against existing payments: same member, same amount, transfer date ±3 days), `MANUAL_NOTE`, `MANUALLY_ENTERED`.
3. Admin maps name aliases → memberships, fixes periods, and chooses per row: import / skip (with reason).
4. Commit creates payments with `source = IMPORT`, status `SUBMITTED`, the original row reference and notes, and `PROPOSED` allocations when a matching charge exists. Nothing is auto-verified, though the admin may bulk-verify after reviewing.
5. Summary: imported / skipped / duplicate / unresolved counts. Raw rows stay forever for audit.
6. Each membership has `reconciliationStatus` (`UNRECONCILED` → `RECONCILED`), which the admin sets after checking charges vs payments. Dashboards show an "unreconciled" banner until then.
