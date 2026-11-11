// Expense rules shared by the admin page and the crew app: allowed values (they mirror the
// database check constraints), what the crew may choose, and receipt file paths.

export const CATEGORIES = [
  "Chemicals",
  "Towels / Supplies",
  "Equipment",
  "Fuel",
  "Truck Maintenance / Repairs",
  "Advertising / Marketing",
  "Website / Software",
  "Insurance",
  "Phone",
  "Payment Processing Fees",
  "Business Meals",
  "Office / Admin",
  "Taxes / Fees",
  "Other",
];

export const TYPES = ["Direct Cost", "Operating Expense", "Asset Purchase", "Owner Draw", "Owner Contribution", "Liability Payment"];

export const PAYMENT_METHODS = ["Cash", "PayPal", "Venmo", "Check", "Credit/Debit", "Credit Card", "Debit Card", "Bank Transfer", "Other"];

// What the crew sees: plain choices, mapped to bookkeeping values.
export const CREW_CATEGORIES = ["Chemicals", "Towels / Supplies", "Equipment", "Fuel", "Truck Maintenance / Repairs", "Business Meals", "Other"];
export const CREW_PAID_WITH = {
  company_card: { label: "Company card", payment_method: "Credit/Debit", reimburse: false },
  company_cash: { label: "Company cash", payment_method: "Cash", reimburse: false },
  own_money: { label: "My own money — pay me back", payment_method: "Other", reimburse: true },
};

/** Default bookkeeping type for a category (managers can change it when approving). */
export function suggestType(category) {
  if (["Chemicals", "Towels / Supplies", "Fuel"].includes(category)) return "Direct Cost";
  return "Operating Expense";
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
export const RECEIPT_TYPES = Object.keys(EXT);

export function receiptPath(owner, id, contentType) {
  return `receipts/${owner}/${id}.${EXT[contentType] || "jpg"}`;
}

/** Only paths minted by receipt-upload-url are accepted (owner = staff uuid or "admin"). */
export function isReceiptPath(path) {
  return typeof path === "string" &&
    /^receipts\/([0-9a-f-]{36}|admin)\/[0-9a-f-]{36}\.(jpg|png|webp|heic|pdf)$/.test(path);
}

/** Validates a crew expense submission. Returns { error } or { expense } ready to insert. */
export function parseCrewExpense(body, { today, staffId }) {
  const amount = Number(body.amount);
  const vendor = String(body.vendor || "").trim();
  const paid = CREW_PAID_WITH[body.paid_with];
  const date = String(body.expense_date || today);

  if (!isReceiptPath(body.receipt_path)) return { error: "Take a photo of the receipt first" };
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount on the receipt" };
  if (amount > 5000) return { error: "That's over $5,000 — please give the receipt to a manager" };
  if (!vendor) return { error: "Where was it bought? (store name)" };
  if (!CREW_CATEGORIES.includes(body.category)) return { error: "Pick what it was for" };
  if (!paid) return { error: "Pick how you paid" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) return { error: "Pick the receipt date (not in the future)" };

  return {
    expense: {
      expense_date: date,
      vendor: vendor.slice(0, 120),
      category: body.category,
      expense_type: suggestType(body.category),
      description: body.description ? String(body.description).trim().slice(0, 300) : null,
      amount: Math.round(amount * 100) / 100,
      payment_method: paid.payment_method,
      reimburse: paid.reimburse,
      receipt_path: body.receipt_path,
      receipt_saved: true,
      status: "pending",
      submitted_by_staff_id: staffId,
      created_by: staffId,
    },
  };
}

/** Validates a manager's review. Returns { error } or { update }. */
export function parseReview(body, reviewer) {
  if (!["approved", "rejected"].includes(body.status)) return { error: "Choose approve or reject" };
  const update = {
    status: body.status,
    reviewed_by: reviewer,
    reviewed_at: new Date().toISOString(),
    review_note: body.note ? String(body.note).slice(0, 300) : null,
  };
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: "Invalid category" };
    update.category = body.category;
  }
  if (body.expense_type !== undefined) {
    if (!TYPES.includes(body.expense_type)) return { error: "Invalid expense type" };
    update.expense_type = body.expense_type;
  }
  if (body.payment_method !== undefined) {
    if (!PAYMENT_METHODS.includes(body.payment_method)) return { error: "Invalid payment method" };
    update.payment_method = body.payment_method;
  }
  if (body.amount !== undefined) {
    const a = Number(body.amount);
    if (!Number.isFinite(a) || a < 0) return { error: "Invalid amount" };
    update.amount = Math.round(a * 100) / 100;
  }
  return { update };
}
