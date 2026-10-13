# Administrator guide

## One-time setup

1. **Create your account** with `npm run create-admin` (see README) and open the invitation link.
2. **General settings** (Apartment Settings → General): apartment name, rent due day (e.g. the 1st), grace days before "overdue" (e.g. 3), upload size limit.
3. **Invite residents** (→ Residents). Enter each person's move-in date. The first billed month defaults to the move-in month if they move in on or before the 15th. You can override it.
4. **Configure prices** (→ Prices & rules). Create one rule per category:
   - *Rent*: usually "Equal split" of the apartment total, or "Custom" if rooms differ.
   - *Electricity*: "Fixed amount per resident" (monthly advance) or "Equal split" of the bill.
   - Set **Effective from** to the first month the price applies.
5. **Generate and finalise** the current month (→ Monthly obligations). Check the review table: every split must reconcile exactly with its total.
6. **Reminders** (→ Reminders & email): defaults are 3 days before, on the due date, and 3 and 7 days after. Residents whose month is verified as paid are skipped.

## Monthly routine (5 minutes)

1. Around the 20th: **Monthly obligations → Generate drafts** for next month → review → **Finalise**. Residents are notified in the app.
2. As payments arrive: **Payments → Awaiting review**. Open each payment, compare the receipt with your bank statement, check the proposed allocation, then **Verify**. Use **Ask a question** if something is unclear, and **Reject** if the transfer never arrived.
3. Look at the dashboard: "Residents x/5 paid", the overdue count, and the chart.

## Price changes

Prices & rules → **Change price** on the current rule. Then:

1. Enter the new amount and the month it takes effect.
2. The preview shows each resident's old and new amounts. If any month from that date is already finalised, you get a warning: those months keep the old amount, so fix them with adjustments if needed.
3. Enter the reason (shown to residents) and **Confirm price change**. Residents get an email and an in-app notification, and the change is added to the permanent history.
4. Upload the landlord's or supplier's letter under Documents (category "Rent increase letter" or "Electricity price change").

Rent and electricity change independently.

## Corrections: never edit, always correct

| Situation | What to do |
|---|---|
| Payment allocated to the wrong month | Payment → Correct this payment → Change allocation (needs a reason) |
| Transfer bounced or recorded twice | Payment → Reverse payment |
| Charge was wrong (draft) | Monthly obligations → edit the amount, or Remove |
| Charge was wrong (final) | Void it (allocated money becomes credit), then add the right charge, or record an adjustment |
| Splitwise settlement or a one-off credit | Residents → resident → Adjustments (type *Settlement* or *Credit*, direction "owes less") |
| Operating-cost settlement (Betriebskosten) | Monthly obligations → month → Add a manual charge, category *Operating costs* |
| Deposit | Manual charge, category *Security deposit* / *Rent buffer*. Refunds go under Residents → Deposits |
| Use deposit for rent (agreed) | Residents → Deposits → Apply deposit to an obligation |

Every correction is recorded in the audit log with who made it, when and why.

## Your own share

Transfers go to you, so your own share never appears as a bank transfer. Record it as a payment for yourself. If you're the only administrator, the app lets you verify it and marks it *self-verified* in the audit log. If there is a second administrator, they must verify it.

## Importing the old Google-Form spreadsheet

1. Apartment Settings → **Historical import** → upload `Rent Tracker.xlsx`.
2. **Names to match:** map spellings such as "Jhon" or "John (By Mia)" to the right resident. The mapping is remembered.
3. Work through **Needs a decision**. Each row shows the flags:
   - *Possible duplicate*: same person, amount and date as another row. Decide whether it was really two transfers.
   - *Date mismatch*: the transfer date doesn't match the submission date (often a typo in the year). Correct the date.
   - *Manual note*: rows corrected in the sheet. The note is kept on the payment.
   - *Formula amount*: the split (e.g. 169,40 + 206,80) is shown so you can allocate rent and deposit separately.
4. **Commit**. Rows become *submitted* payments, not paid.
5. **Reconcile:** create the historical rules or charges for those months (or one *opening balance* adjustment per resident), finalise the months, then use **Verify fully matched** on the import page. Check the remaining payments one by one.
6. When a resident's history adds up, open Residents → resident → **Mark as reconciled**. Until then, they see a "not yet reconciled" notice.

The import can only run once unless you explicitly confirm another import. Skipped rows keep their reason, and the original rows stay visible.
