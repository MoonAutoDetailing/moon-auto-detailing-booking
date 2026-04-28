# Bookkeeping Feature — Deploy Guide

This update adds payment tracking to job completion, an Expenses log in the admin panel, and a one-click Excel bookkeeping export.

## What changed

### New files
- `supabase/migrations/20260427120000_bookkeeping.sql` — adds `job_payments` and `expenses` tables.
- `api/admin-record-expense.js` — POST: log a new expense.
- `api/admin-list-expenses.js` — GET: list expenses for a month.
- `api/admin-delete-expense.js` — POST: delete an expense by id.
- `api/export-bookkeeping.js` — GET: stream the live `.xlsx` workbook.

### Modified files
- `package.json` — added `exceljs` dependency.
- `api/admin-complete-booking.js` — now requires `amount_collected` + `payment_method`, optionally accepts `tip_amount` + `payment_notes`. Inserts into `job_payments` after the booking status flips to `completed`. Rolls back booking status (and deletes the payment row) if any downstream step fails. **All existing subscription activation and cycle completion logic is unchanged.**
- `admin.html` — adds a payment modal, an Expenses view (with a "+ New Expense" form), and a Bookkeeping view with a download button. The "Job Completed" button now opens the modal instead of completing instantly.

## Deploy steps

### 1. Branch
```bash
git checkout -b feature/bookkeeping
git add .
git status   # review the file list
git commit -m "feat: bookkeeping (payments + expenses + workbook export)"
```

### 2. Install the new dependency
```bash
npm install
# This installs exceljs and updates package-lock.json. Commit the lockfile.
git add package-lock.json
git commit -m "chore: add exceljs to lockfile"
```

### 3. Run the migration in Supabase

Apply `supabase/migrations/20260427120000_bookkeeping.sql` using your normal flow:

- Supabase CLI: `supabase db push`
- Or paste the SQL into Supabase Studio → SQL Editor → Run.

Verify the tables exist:
```sql
select count(*) from public.job_payments;   -- should return 0
select count(*) from public.expenses;       -- should return 0
```

### 4. Push and preview
```bash
git push -u origin feature/bookkeeping
```

Vercel should build a preview deploy. Test on the preview URL (use `?x-vercel-protection-bypass=...` in dev). Do NOT skip the preview test — your handoff doc requires live testing on a real deploy.

### 5. Test checklist (matches your existing handoff style)

- [ ] Complete a confirmed booking → modal opens → enter amount + method → submit → success toast.
- [ ] Verify `select * from job_payments` shows the row with the right amount, tip, method.
- [ ] Verify `bookings.status = 'completed'`.
- [ ] Verify the booking-completed email arrived (check Resend logs).
- [ ] Try to submit the modal with no amount → blocked client-side.
- [ ] Try to submit with no payment method → blocked client-side.
- [ ] Open the Expenses view → "+ New Expense" → fill form → save → expense appears in list.
- [ ] Delete an expense → confirm prompt → expense disappears.
- [ ] Switch the month picker on Expenses → confirm only that month's rows show.
- [ ] Open Bookkeeping view → click Download → `.xlsx` downloads.
- [ ] Open the `.xlsx` in Excel → confirm Jobs sheet has your test bookings, Expenses sheet has your test expenses, Monthly Summary aggregates.
- [ ] **Regression check:** Complete a subscription cycle booking → confirm `subscription_cycles.status = 'completed'` and `subscriptions.completed_cycles_count` incremented.

### 6. Merge to main
After all tests pass:
```bash
git checkout main
git merge feature/bookkeeping
git push
```

## Rollback

If anything goes wrong in production:

1. **Code:** `git revert` the merge commit and push.
2. **Database:** the migration only adds tables and is idempotent (`if not exists`). To fully roll back, drop the new tables:
   ```sql
   drop table if exists public.job_payments;
   drop table if exists public.expenses;
   ```
   No existing tables were modified, so this is safe.

## Architecture notes (for future you)

- **Source of truth is Supabase.** The Excel file is a generated report, not a source of truth. You can regenerate it any time.
- **Once a payment is recorded, it's final.** The UI does not expose an edit flow. If you ever need to correct one, do it directly in Supabase Studio (and update the booking status if needed).
- **The Excel export queries `bookings` with `status in ('completed','cancelled')`** so cancelled bookings show up in the Jobs sheet with a Cancelled status. They do NOT count toward revenue (the Monthly Summary formulas filter on `Booking Status = "Completed"`).
- **`exceljs` adds ~5 MB to `node_modules`.** Vercel function size limit is 50 MB unzipped; we're well under it.
- **The export endpoint uses the same `verifyAdmin` pattern** as every other admin route — no separate auth.
- **`amount_collected` is what hit your account, before tip.** If you ever want a different definition (e.g., gross with tip), the change is one column in `export-bookkeeping.js`.

## New observability events

These show up in Vercel function logs:
- `JOB_PAYMENT_RECORDED` — every successful Complete.
- `JOB_PAYMENT_INSERT_FAILED` — payment write failed (booking rolled back).
- `EXPENSE_RECORDED` — every new expense.
- `EXPENSE_DELETED` — every expense deletion.
- `BOOKKEEPING_EXPORTED` — every workbook download (includes row counts).
