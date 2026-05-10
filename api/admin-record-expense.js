import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const ALLOWED_CATEGORIES = [
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
  "Other"
];

const ALLOWED_TYPES = [
  "Direct Cost",
  "Operating Expense",
  "Asset Purchase",
  "Owner Draw",
  "Owner Contribution",
  "Liability Payment"
];

const ALLOWED_PAYMENT_METHODS = [
  "Cash","PayPal","Venmo","Check","Credit Card","Bank Transfer","Other"
];

/** POST: record an expense.
 *  Body: expense_date (YYYY-MM-DD), vendor, category, expense_type,
 *        description?, amount, payment_method, receipt_saved?, notes?
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let adminInfo;
  try {
    adminInfo = await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const expense_date = String(body.expense_date ?? "").trim();
    const vendor = String(body.vendor ?? "").trim();
    const category = String(body.category ?? "").trim();
    const expense_type = String(body.expense_type ?? "").trim();
    const description = body.description != null ? String(body.description).trim() : null;
    const amountNum = body.amount != null ? Number(body.amount) : NaN;
    const payment_method = String(body.payment_method ?? "").trim();
    const receipt_saved = body.receipt_saved === true;
    const notes = body.notes != null ? String(body.notes).trim() : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      return res.status(400).json({ error: "expense_date must be YYYY-MM-DD." });
    }
    if (!vendor) return res.status(400).json({ error: "Vendor is required." });
    if (ALLOWED_CATEGORIES.indexOf(category) === -1) {
      return res.status(400).json({ error: "Invalid category." });
    }
    if (ALLOWED_TYPES.indexOf(expense_type) === -1) {
      return res.status(400).json({ error: "Invalid expense_type." });
    }
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      return res.status(400).json({ error: "Amount must be a non-negative number." });
    }
    if (ALLOWED_PAYMENT_METHODS.indexOf(payment_method) === -1) {
      return res.status(400).json({ error: "Invalid payment_method." });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const insertPayload = {
      expense_date,
      vendor,
      category,
      expense_type,
      amount: Math.round(amountNum * 100) / 100,
      payment_method,
      receipt_saved
    };
    if (description) insertPayload.description = description;
    if (notes) insertPayload.notes = notes;
    if (adminInfo && adminInfo.admin && adminInfo.admin.id) {
      insertPayload.created_by = adminInfo.admin.id;
    }

    const { data: row, error } = await supabase
      .from("expenses")
      .insert(insertPayload)
      .select("id, expense_date, vendor, category, expense_type, description, amount, payment_method, receipt_saved, notes, created_at")
      .single();

    if (error) {
      console.error("admin-record-expense insert failed", error);
      return res.status(500).json({ error: "Database insert failed" });
    }

    console.log("EXPENSE_RECORDED", {
      expense_id: row.id,
      amount: row.amount,
      category: row.category,
      expense_type: row.expense_type
    });

    return res.status(200).json({ ok: true, expense: row });
  } catch (err) {
    console.error("admin-record-expense error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
