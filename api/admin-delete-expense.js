import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** POST: hard delete an expense. Body: expense_id. */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const expense_id = body.expense_id || body.expenseId;
    if (!expense_id) {
      return res.status(400).json({ error: "Missing expense_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { error } = await supabase
      .from("expenses")
      .delete()
      .eq("id", expense_id);

    if (error) {
      console.error("admin-delete-expense failed", error);
      return res.status(500).json({ error: "Database delete failed" });
    }

    console.log("EXPENSE_DELETED", { expense_id });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-delete-expense error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
