#!/usr/bin/env node
/**
 * Diagnose expense insert failures against Supabase and/or the admin API.
 *
 * Direct DB (shows exact Supabase/Postgres error):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-expense-insert.js
 *
 * Via deployed admin API:
 *   BASE_URL=https://moonautodetailingbooking.com ADMIN_PASSWORD=... node scripts/test-expense-insert.js --api
 */

import { createClient } from "@supabase/supabase-js";

const USE_API = process.argv.includes("--api");
const BASE_URL = (process.env.BASE_URL || "https://moonautodetailingbooking.com").replace(/\/$/, "");

const CASES = [
  {
    name: "Labor-ish / Cash",
    row: {
      expense_date: "2026-05-22",
      vendor: "Test Labor Vendor",
      category: "Other",
      expense_type: "Operating Expense",
      amount: 50,
      payment_method: "Cash",
      receipt_saved: false,
      description: "Labor test",
      notes: "test script"
    }
  },
  {
    name: "Fuel / Credit Card",
    row: {
      expense_date: "2026-05-22",
      vendor: "Sunoco",
      category: "Fuel",
      expense_type: "Operating Expense",
      amount: 120,
      payment_method: "Credit Card",
      receipt_saved: true,
      description: "Sunoco Valatie",
      notes: "Debitcard"
    }
  },
  {
    name: "Fuel / Cash",
    row: {
      expense_date: "2026-05-22",
      vendor: "Sunoco",
      category: "Fuel",
      expense_type: "Operating Expense",
      amount: 120,
      payment_method: "Cash",
      receipt_saved: false
    }
  },
  {
    name: "Other / Credit Card",
    row: {
      expense_date: "2026-05-22",
      vendor: "Test Vendor",
      category: "Other",
      expense_type: "Operating Expense",
      amount: 25,
      payment_method: "Credit Card",
      receipt_saved: false
    }
  },
  {
    name: "Operating Expense / Credit Card (Equipment)",
    row: {
      expense_date: "2026-05-22",
      vendor: "Test Vendor",
      category: "Equipment",
      expense_type: "Operating Expense",
      amount: 99,
      payment_method: "Credit Card",
      receipt_saved: false
    }
  }
];

function fmtError(error) {
  if (!error) return "OK";
  return JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint
  }, null, 2);
}

async function loginAdmin() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("Missing ADMIN_PASSWORD for --api mode");
  const res = await fetch(`${BASE_URL}/api/admin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(`admin-login failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data.token;
}

async function runDirect() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const supabase = createClient(url, key);
  console.log("Mode: direct Supabase (service role)\n");

  for (const test of CASES) {
    console.log(`=== ${test.name} ===`);
    const { data, error } = await supabase
      .from("expenses")
      .insert(test.row)
      .select("id, payment_method, category")
      .single();
    if (error) {
      console.log(fmtError(error));
    } else {
      console.log("OK", data);
      await supabase.from("expenses").delete().eq("id", data.id);
      console.log("(test row deleted)");
    }
    console.log("");
  }
}

async function runApi(token) {
  console.log("Mode: admin API\n");
  for (const test of CASES) {
    console.log(`=== ${test.name} ===`);
    const res = await fetch(`${BASE_URL}/api/admin-record-expense`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-session": token
      },
      body: JSON.stringify(test.row)
    });
    const data = await res.json().catch(() => ({}));
    console.log(`HTTP ${res.status}`, JSON.stringify(data, null, 2));
    console.log("");
  }
}

async function main() {
  if (USE_API) {
    const token = await loginAdmin();
    await runApi(token);
  } else {
    await runDirect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
