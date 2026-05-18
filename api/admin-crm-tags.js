import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeTagName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

async function verifyCustomer(supabase, customerId) {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function verifyTag(supabase, tagId) {
  const { data, error } = await supabase
    .from("crm_tags")
    .select("*")
    .eq("id", tagId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadAssignedTags(supabase, customerId) {
  const { data: assignments, error: assignmentError } = await supabase
    .from("crm_customer_tags")
    .select("*")
    .eq("customer_id", customerId);

  if (assignmentError) throw assignmentError;

  const tagIds = [...new Set((assignments || []).map((row) => row.tag_id).filter(Boolean))];
  if (tagIds.length === 0) return [];

  const { data: tags, error: tagsError } = await supabase
    .from("crm_tags")
    .select("*")
    .in("id", tagIds)
    .order("name", { ascending: true });

  if (tagsError) throw tagsError;
  return tags || [];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-tags: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    if (req.method === "GET") {
      const customerId = clean(req.query.customer_id);
      const { data: tags, error: tagsError } = await supabase
        .from("crm_tags")
        .select("*")
        .order("name", { ascending: true });

      if (tagsError) throw tagsError;

      if (!customerId) {
        return res.status(200).json({ ok: true, tags: tags || [] });
      }

      const assignedTags = await loadAssignedTags(supabase, customerId);
      return res.status(200).json({
        ok: true,
        tags: tags || [],
        assigned_tags: assignedTags
      });
    }

    const body = req.body || {};
    const action = clean(body.action);
    const supportedActions = ["create_tag", "assign_tag", "remove_tag"];

    if (!supportedActions.includes(action)) {
      return res.status(400).json({ ok: false, error: "Invalid action" });
    }

    if (action === "create_tag") {
      const name = normalizeTagName(body.name);
      if (!name) {
        return res.status(400).json({ ok: false, error: "Missing name" });
      }

      const { data: existingTag, error: existingTagError } = await supabase
        .from("crm_tags")
        .select("*")
        .eq("name", name)
        .maybeSingle();

      if (existingTagError) throw existingTagError;
      if (existingTag) {
        return res.status(200).json({ ok: true, tag: existingTag, assignment: null });
      }

      const { data: tag, error: tagError } = await supabase
        .from("crm_tags")
        .insert([{
          name,
          description: clean(body.description)
        }])
        .select("*")
        .single();

      if (tagError) throw tagError;
      return res.status(200).json({ ok: true, tag, assignment: null });
    }

    const customerId = clean(body.customer_id);
    const tagId = clean(body.tag_id);

    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }
    if (!tagId) {
      return res.status(400).json({ ok: false, error: "Missing tag_id" });
    }

    if (action === "assign_tag") {
      const customer = await verifyCustomer(supabase, customerId);
      if (!customer) {
        return res.status(404).json({ ok: false, error: "Customer not found" });
      }

      const tag = await verifyTag(supabase, tagId);
      if (!tag) {
        return res.status(404).json({ ok: false, error: "Tag not found" });
      }

      const { data: existingAssignment, error: existingAssignmentError } = await supabase
        .from("crm_customer_tags")
        .select("*")
        .eq("customer_id", customerId)
        .eq("tag_id", tagId)
        .maybeSingle();

      if (existingAssignmentError) throw existingAssignmentError;
      if (existingAssignment) {
        return res.status(200).json({ ok: true, tag, assignment: existingAssignment });
      }

      const { data: assignment, error: assignmentError } = await supabase
        .from("crm_customer_tags")
        .insert([{
          customer_id: customerId,
          tag_id: tagId
        }])
        .select("*")
        .single();

      if (assignmentError) throw assignmentError;
      return res.status(200).json({ ok: true, tag, assignment });
    }

    const customer = await verifyCustomer(supabase, customerId);
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const tag = await verifyTag(supabase, tagId);
    if (!tag) {
      return res.status(404).json({ ok: false, error: "Tag not found" });
    }

    const { error: deleteError } = await supabase
      .from("crm_customer_tags")
      .delete()
      .eq("customer_id", customerId)
      .eq("tag_id", tagId);

    if (deleteError) throw deleteError;
    return res.status(200).json({ ok: true, tag, assignment: null });
  } catch (err) {
    console.error("admin-crm-tags error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
