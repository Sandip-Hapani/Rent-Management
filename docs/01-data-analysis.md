# Existing workflow & data analysis

Sources reviewed: the Google Form "Rent Tracker" and `data/Rent Tracker.xlsx` (sheet `Form responses 1`).

## Google Form

> "add the details of the rent and electricity bill transfer to <primary contact>"

| Field | Type | Required | Options |
|---|---|---|---|
| For which month are you transferring | dropdown | yes | January … December (**no year**) |
| Name | dropdown | no | five first names (Residents A–E in this document) |
| Select Bank | radio + "Other" | yes | Santander, Deutsche Bank, Wise, Sparkasse, Other (free text) |
| Transferred amount in Euro | text | no | free text |
| Descriptions | text | no | free text |
| Does it include Deposit? | Yes/No | yes | |
| Does it include Electricity? | Yes/No | yes | |
| Date (actual transfer date) | date | yes | |

Payments go to the primary contact (P), who does not appear as a payer in the sheet.

## Workbook structure

`Form responses 1` reports 1,110 rows × 37 columns, but only **115 data rows** contain anything (rows 2–116).
Columns used: A Timestamp, B Month, C Deposit?, D Electricity?, E Date, F *(empty, unnamed)*,
G Bank, H Amount, I Description, J Email *(always empty)*, K Name, L *(unnamed — manual correction notes)*.

### Findings that drive the import design

| # | Finding | Rows (sheet row no.) | Import handling |
|---|---|---|---|
| 1 | The rent month has **no year**. | all | Infer the year from the transfer date and submission timestamp. Flag the row when they disagree. |
| 2 | **Amounts are formulas** in 9 rows (`=169.4+206.8`, `=169.4+23.6+23.6`, `=191.8+6.6+132.17`). They show how the amount splits by category. | 2–5, 10–13, 57 | Evaluate the arithmetic safely (digits, `.`, `+`, `-` only) and keep the formula as a suggested split. |
| 3 | **Transfer-date typos**: the year is +1 vs the submission (`2025-12-11` submitted `2024-12-11`). There is also a probable day/month swap (`2025-01-12` for Dec 2025). | 32, 33, 78 | Flag `DATE_INCONSISTENT` and suggest a correction. Never auto-correct. |
| 4 | **Name variants**: Resident E's name appears correctly, misspelled (with a trailing space), and as "E (By B)" when B paid on E's behalf. | 82, 103 | Use an alias table that maps to a resident. Record "paid by another person" as a note. |
| 5 | **Manual corrections** in column L: "Edited by B", "Manually added after discussing with A", "Aug and Sept entries were swapped", "Paid 198.4 but settlement in Splitwise entry". | 34–37, 60, 64, 74 | Keep these as import notes on the payment. Rows with notes are flagged for review. |
| 6 | **Possible duplicates**: same person, same date and same amount, but a different month (`March elec` / `April elec + rent`, both 201.6 on 2026‑03‑29). The same applies to July/Aug 2026 (214.89 on 2026‑08‑03). | 95/96, 110/111 | Flag `POSSIBLE_DUPLICATE`. An admin decides whether these were two transfers. |
| 7 | **Manually added rows** have a midnight timestamp (`00:00:00`). | 33, 41, 49, 57 | Keep them, labelled "manually entered" (low confidence). |
| 8 | **Residents change over time**. Resident A pays from Jun 2024 to Nov 2025. Resident E joins in Nov 2025. Nov 2025 has **6 payers** at 165.33 (=992.00/6, where 992.00 = 5 × 198.40). | 74–78 | Shows that memberships need join/leave months and that split counts vary by month. |
| 9 | **Deposits**: 206.80 security deposit + 169.40 "Rent Buffer Deposit" per person (Jun 2024). Resident E paid 399.80 "Deposit and Rent buffer" in one transfer (Mar 2026). | 2–9, 92 | Deposit and rent-buffer categories are kept separate from rent. Combined transfers are split explicitly. |
| 10 | **Mixed-category transfers**: Rent + electricity + operating-cost settlement (`Betriebskosten`), for example 533.57 = 214.89 + 318.68. | 56–57, 87–88, 108–109 | Needs explicit multi-category allocation. |
| 11 | **Off-platform settlements** through Splitwise ("7.09 € through splitwise", "SW - 140.64"). | 74, 89, 104 | Represent these as explicit adjustments and never infer them. |
| 12 | **Gaps**: Resident D has no entries after Jun 2026. Resident B has none for Aug–Sep 2026. Resident A has no entries for Dec 2025 (left?). | — | Reconciliation shows these as outstanding. They are **not** treated as fact until an admin confirms them. |
| 13 | **Monthly per-person amounts over time**: 193.00 → 188.60 → 191.80 → 198.40 → 199.20 → 201.60 → 204.00 → 214.89. The rent/electricity split is mostly unknown (only Jul 2024: 169.40 + 23.60, and Feb 2026: 201.60 rent + 25.60 elec, which contradicts the 201.60 total used elsewhere). | — | Historical prices can't be derived from the sheet with confidence. An admin enters them. |
| 14 | Banks seen: Deutsche Bank, Sparkasse, Wise, Expatrio, N‑26 (+ form option Santander). | — | Banks are a free-text field with suggestions, not an enum. |

Conclusion: the sheet is a **log of claimed transfers**, not a ledger. It has no charges, no allocations and no balances.
Imported rows therefore become *unverified payments*. Balances exist only after an admin configures the historical charges and reconciles them.

## Open business questions (need confirmation)

1. **Who are the five current residents?** The data suggests P (primary contact) + Residents B, C, D and E, with Resident A having left after Nov 2025. Is that right? Who is the administrator?
2. **Does the administrator also owe rent?** P receives the transfers, so the admin's own share never shows up as a transfer. Should the admin's share be tracked as self-settled, or not at all?
3. **Historical prices**: what were the rent and electricity amounts per person for each period since Jun 2024? Without them, historical balances stay "unreconciled".
4. **Opening balances**: should the ledger start from Jun 2024 (full history) or from a cut-over month, with agreed opening balances?
5. **Nov 2025 split** (6 × 165.33): was that a one-off overlap month with Residents A and E both present?
6. **Join/leave mid-month**: should a resident pay a full month, a pro-rated share, or a custom amount?
7. **Operating-cost settlements (Betriebskosten / Nebenkostenabrechnung)**: are these split equally between the people who lived there in the settlement year, or between current residents?
8. **Deposit refunds**: was Resident A's 206.80 + 169.40 refunded, transferred to Resident E, or offset? (E paid 399.80, not 376.20.)
9. **Splitwise settlements**: should they be recorded as adjustments in this app from now on, or kept outside it?
10. **Due date**: what day of the month is rent due (the data suggests "by the 1st", with transfers often a few days late)? How many days of grace before a payment counts as overdue?
11. **Rows 95/96 and 110/111**: were these two separate transfers?
