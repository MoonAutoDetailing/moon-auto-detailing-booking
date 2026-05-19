import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

const MAX_GROUPS = 100;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function phonesPartialMatch(phoneA, phoneB) {
  if (!phoneA || !phoneB) return false;
  if (phoneA === phoneB) return true;
  const minLen = 7;
  if (phoneA.length < minLen || phoneB.length < minLen) return false;
  const suffixA = phoneA.slice(-minLen);
  const suffixB = phoneB.slice(-minLen);
  return suffixA === suffixB;
}

function emailsPartialMatch(emailA, emailB) {
  if (!emailA || !emailB) return false;
  if (emailA === emailB) return true;
  const atA = emailA.indexOf("@");
  const atB = emailB.indexOf("@");
  if (atA <= 0 || atB <= 0) return false;
  const localA = emailA.slice(0, atA);
  const localB = emailB.slice(0, atB);
  const domainA = emailA.slice(atA + 1);
  const domainB = emailB.slice(atB + 1);
  if (domainA !== domainB) return false;
  return localA === localB || localA.startsWith(localB) || localB.startsWith(localA);
}

function namesSimilar(nameA, nameB) {
  if (!nameA || !nameB) return false;
  if (nameA === nameB) return true;
  if (nameA.includes(nameB) || nameB.includes(nameA)) return true;
  const firstA = nameA.split(" ")[0];
  const firstB = nameB.split(" ")[0];
  return firstA.length >= 3 && firstA === firstB;
}

function toCustomerPayload(row) {
  return {
    customer_id: row.customer_id || row.id,
    full_name: row.full_name || null,
    phone: row.phone || null,
    email: row.email || null,
    address: row.address || null,
    created_at: row.created_at || null,
    lifecycle_stage: row.lifecycle_stage || null,
    crm_status: row.crm_status || row.status || null,
    total_bookings: Number(row.total_bookings) || 0,
    completed_bookings: Number(row.completed_bookings) || 0,
    total_revenue: Number(row.total_revenue) || 0,
    last_service_date: row.last_service_date || null,
    last_contacted_at: row.last_contacted_at || null
  };
}

async function fetchAllSummaryRows(supabase) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;

  while (from < 50000) {
    const { data, error } = await supabase
      .from("crm_customer_summary")
      .select("*")
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function addGroup(groups, seen, reason, confidence, matchKey, customerRows) {
  if (!customerRows || customerRows.length < 2) return;

  const ids = [...new Set(customerRows.map((row) => row.customer_id || row.id))]
    .filter(Boolean)
    .sort();

  if (ids.length < 2) return;

  const dedupeKey = `${reason}:${ids.join(",")}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  const byId = new Map(customerRows.map((row) => [row.customer_id || row.id, row]));
  const uniqueRows = ids.map((id) => byId.get(id)).filter(Boolean);

  groups.push({
    reason,
    confidence,
    match_key: matchKey,
    customers: uniqueRows.map(toCustomerPayload)
  });
}

function detectDuplicateGroups(rows) {
  const groups = [];
  const seen = new Set();

  const phoneMap = new Map();
  const emailMap = new Map();
  const nameMap = new Map();
  const addressMap = new Map();

  for (const row of rows) {
    const customerId = row.customer_id || row.id;
    if (!customerId) continue;

    const phone = normalizePhone(row.phone);
    if (phone) {
      if (!phoneMap.has(phone)) phoneMap.set(phone, []);
      phoneMap.get(phone).push(row);
    }

    const email = normalizeEmail(row.email);
    if (email) {
      if (!emailMap.has(email)) emailMap.set(email, []);
      emailMap.get(email).push(row);
    }

    const name = normalizeName(row.full_name);
    if (name) {
      if (!nameMap.has(name)) nameMap.set(name, []);
      nameMap.get(name).push(row);
    }

    const address = normalizeAddress(row.address);
    if (address.length >= 8) {
      if (!addressMap.has(address)) addressMap.set(address, []);
      addressMap.get(address).push(row);
    }
  }

  for (const [phone, group] of phoneMap) {
    addGroup(groups, seen, "same_phone", "high", phone, group);
  }

  for (const [email, group] of emailMap) {
    addGroup(groups, seen, "same_email", "high", email, group);
  }

  for (const [name, bucket] of nameMap) {
    if (bucket.length < 2) continue;

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const left = bucket[i];
        const right = bucket[j];
        const phoneA = normalizePhone(left.phone);
        const phoneB = normalizePhone(right.phone);
        const emailA = normalizeEmail(left.email);
        const emailB = normalizeEmail(right.email);

        if (!phonesPartialMatch(phoneA, phoneB) && !emailsPartialMatch(emailA, emailB)) {
          continue;
        }

        const matchKey = [
          name,
          phonesPartialMatch(phoneA, phoneB) ? phoneA || phoneB : "",
          emailsPartialMatch(emailA, emailB) ? emailA || emailB : ""
        ].filter(Boolean).join("|");

        addGroup(groups, seen, "same_name_partial_contact", "medium", matchKey, [left, right]);
      }
    }
  }

  for (const [address, bucket] of addressMap) {
    if (bucket.length < 2) continue;

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const left = bucket[i];
        const right = bucket[j];
        const nameA = normalizeName(left.full_name);
        const nameB = normalizeName(right.full_name);

        if (!namesSimilar(nameA, nameB)) continue;

        const matchKey = `${address}|${nameA}|${nameB}`;
        addGroup(groups, seen, "same_address_similar_name", "medium", matchKey, [left, right]);
      }
    }
  }

  const confidenceRank = { high: 0, medium: 1, low: 2 };
  groups.sort((a, b) => {
    const conf = confidenceRank[a.confidence] - confidenceRank[b.confidence];
    if (conf !== 0) return conf;
    return b.customers.length - a.customers.length;
  });

  return groups.slice(0, MAX_GROUPS);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-duplicates: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const rows = await fetchAllSummaryRows(supabase);
    const duplicateGroups = detectDuplicateGroups(rows);

    return res.status(200).json({
      ok: true,
      duplicate_groups: duplicateGroups,
      count: duplicateGroups.length
    });
  } catch (err) {
    console.error("admin-crm-duplicates error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
