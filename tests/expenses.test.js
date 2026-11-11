// Expense rules: crew submissions (receipt required, mapped to bookkeeping values),
// manager reviews, receipt paths, and that allowed values match the database constraints.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  TYPES,
  PAYMENT_METHODS,
  CREW_CATEGORIES,
  CREW_PAID_WITH,
  suggestType,
  receiptPath,
  isReceiptPath,
  parseCrewExpense,
  parseReview,
} from "../api/_expenses.js";

const STAFF = "33333333-3333-4333-8333-333333333333";
const FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const path = receiptPath(STAFF, FILE, "image/jpeg");
const ctx = { today: "2026-11-11", staffId: STAFF };
const good = { receipt_path: path, amount: "42.567", vendor: " AutoZone ", category: "Chemicals", paid_with: "own_money" };

test("receipt paths are minted per owner and validated strictly", () => {
  assert.equal(path, `receipts/${STAFF}/${FILE}.jpg`);
  assert.equal(receiptPath("admin", FILE, "application/pdf"), `receipts/admin/${FILE}.pdf`);
  assert.equal(isReceiptPath(path), true);
  assert.equal(isReceiptPath(`receipts/admin/${FILE}.pdf`), true);
  assert.equal(isReceiptPath(`jobs/${STAFF}/after/${FILE}.jpg`), false);
  assert.equal(isReceiptPath(`receipts/${STAFF}/../x/${FILE}.jpg`), false);
  assert.equal(isReceiptPath(`receipts/${STAFF}/${FILE}.exe`), false);
});

test("crew submission maps to bookkeeping values and waits for approval", () => {
  const { expense } = parseCrewExpense(good, ctx);
  assert.deepEqual(expense, {
    expense_date: "2026-11-11",
    vendor: "AutoZone",
    category: "Chemicals",
    expense_type: "Direct Cost",
    description: null,
    amount: 42.57,
    payment_method: "Other",
    reimburse: true,
    receipt_path: path,
    receipt_saved: true,
    status: "pending",
    submitted_by_staff_id: STAFF,
    created_by: STAFF,
  });
  const card = parseCrewExpense({ ...good, paid_with: "company_card", category: "Equipment" }, ctx).expense;
  assert.equal(card.payment_method, "Credit/Debit");
  assert.equal(card.reimburse, false);
  assert.equal(card.expense_type, "Operating Expense");
});

test("crew submission is refused without a receipt or with bad values", () => {
  const err = (over) => parseCrewExpense({ ...good, ...over }, ctx).error;
  assert.match(err({ receipt_path: null }), /photo of the receipt/);
  assert.match(err({ amount: 0 }), /amount/);
  assert.match(err({ amount: 9000 }), /over \$5,000/);
  assert.match(err({ vendor: " " }), /store name/);
  assert.match(err({ category: "Owner Draw" }), /what it was for/);
  assert.match(err({ category: "Insurance" }), /what it was for/); // not a crew category
  assert.match(err({ paid_with: "crypto" }), /how you paid/);
  assert.match(err({ expense_date: "2026-11-12" }), /not in the future/);
});

test("manager review validates edits", () => {
  const { update } = parseReview({ status: "approved", category: "Equipment", expense_type: "Asset Purchase", amount: "40.004" }, "Max (m1)");
  assert.equal(update.status, "approved");
  assert.equal(update.category, "Equipment");
  assert.equal(update.expense_type, "Asset Purchase");
  assert.equal(update.amount, 40);
  assert.equal(update.reviewed_by, "Max (m1)");
  assert.ok(update.reviewed_at);
  assert.equal(parseReview({ status: "rejected", note: "Personal purchase" }, "x").update.review_note, "Personal purchase");
  assert.match(parseReview({ status: "maybe" }, "x").error, /approve or reject/);
  assert.match(parseReview({ status: "approved", expense_type: "Fun" }, "x").error, /expense type/);
  assert.match(parseReview({ status: "approved", payment_method: "Zelle" }, "x").error, /payment method/);
});

test("allowed values stay inside the database check constraints", () => {
  // Mirrors expenses_expense_type_check / expenses_payment_method_check on the live schema.
  const dbTypes = ["Direct Cost", "Operating Expense", "Asset Purchase", "Owner Draw", "Owner Contribution", "Liability Payment"];
  const dbMethods = ["Cash", "PayPal", "Venmo", "Check", "Credit/Debit", "Credit Card", "Debit Card", "Bank Transfer", "Other"];
  assert.deepEqual(TYPES, dbTypes);
  for (const m of PAYMENT_METHODS) assert.ok(dbMethods.includes(m), m);
  for (const p of Object.values(CREW_PAID_WITH)) assert.ok(dbMethods.includes(p.payment_method));
  for (const c of CREW_CATEGORIES) assert.ok(CATEGORIES.includes(c), c);
  for (const c of CATEGORIES) assert.ok(TYPES.includes(suggestType(c)));
});
