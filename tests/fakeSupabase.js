// Minimal in-memory stand-in for the supabase-js query builder, enough for the subscription
// code: select/insert/update/delete with eq/neq/in/is/gt/gte/lt/lte/order/limit/single/maybeSingle.
// Unique indexes mirror the live database so conflicts behave like production.
import { randomUUID } from "node:crypto";

const UNIQUE = {
  subscription_cycles: [
    { cols: ["subscription_id", "cycle_index"] },
    { cols: ["subscription_id"], where: (r) => r.status === "open" || r.status === "booked" }
  ],
  subscription_cycle_bookings: [
    { cols: ["cycle_id"], where: (r) => r.released_at == null },
    { cols: ["booking_id"], where: (r) => r.released_at == null }
  ]
};

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createFakeSupabase(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);

  function violatesUnique(name, candidate, ignoreId) {
    for (const rule of UNIQUE[name] || []) {
      if (rule.where && !rule.where(candidate)) continue;
      const clash = table(name).find((r) =>
        r.id !== ignoreId &&
        (!rule.where || rule.where(r)) &&
        rule.cols.every((c) => r[c] === candidate[c])
      );
      if (clash) return `duplicate key on ${name}(${rule.cols.join(",")})`;
    }
    return null;
  }

  class Query {
    constructor(name) {
      this.name = name;
      this.filters = [];
      this.op = "select";
      this.payload = null;
      this.returning = false;
      this.mode = "many";
      this.orders = [];
      this.limitN = null;
    }
    select() { if (this.op === "select") this.op = "select"; else this.returning = true; return this; }
    insert(p) { this.op = "insert"; this.payload = p; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    gt(c, v) { this.filters.push((r) => r[c] != null && r[c] > v); return this; }
    gte(c, v) { this.filters.push((r) => r[c] != null && r[c] >= v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] != null && r[c] < v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] != null && r[c] <= v); return this; }
    order(c, { ascending = true } = {}) { this.orders.push([c, ascending]); return this; }
    limit(n) { this.limitN = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }

    matches() { return table(this.name).filter((r) => this.filters.every((f) => f(r))); }

    shape(rows) {
      if (this.mode === "single") {
        if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}`, code: "PGRST116" } };
        return { data: clone(rows[0]), error: null };
      }
      if (this.mode === "maybe") {
        if (rows.length > 1) return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
        return { data: clone(rows[0] ?? null), error: null };
      }
      return { data: clone(rows), error: null };
    }

    run() {
      if (this.op === "select") {
        let rows = this.matches();
        for (const [c, asc] of [...this.orders].reverse()) {
          rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
        }
        if (this.limitN != null) rows = rows.slice(0, this.limitN);
        return this.shape(rows);
      }
      if (this.op === "insert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created = [];
        for (const p of list) {
          const row = { id: randomUUID(), created_at: new Date().toISOString(), released_at: undefined, ...p };
          if (row.released_at === undefined) delete row.released_at;
          const clash = violatesUnique(this.name, row, null);
          if (clash) return { data: null, error: { message: clash, code: "23505" } };
          table(this.name).push(row);
          created.push(row);
        }
        return this.returning || this.mode !== "many" ? this.shape(created) : { data: null, error: null };
      }
      if (this.op === "update") {
        const rows = this.matches();
        for (const r of rows) {
          const next = { ...r, ...this.payload };
          const clash = violatesUnique(this.name, next, r.id);
          if (clash) return { data: null, error: { message: clash, code: "23505" } };
        }
        for (const r of rows) Object.assign(r, this.payload, { updated_at: new Date().toISOString() });
        return this.returning || this.mode !== "many" ? this.shape(rows) : { data: null, error: null };
      }
      if (this.op === "delete") {
        const rows = this.matches();
        tables[this.name] = table(this.name).filter((r) => !rows.includes(r));
        return { data: null, error: null };
      }
      throw new Error("unsupported op");
    }
  }

  return {
    tables,
    from: (name) => new Query(name)
  };
}

/** Email spy: records every send; can be told to fail. */
export function createSendSpy({ fail = false } = {}) {
  const sent = [];
  const make = (type) => async (cycleId) => {
    if (fail) throw new Error("send failed");
    sent.push({ type, cycleId });
  };
  return {
    sent,
    send: {
      cycleOpen: make("open"),
      reminder1: make("reminder1"),
      reminder2: make("reminder2"),
      missed: make("missed")
    }
  };
}
