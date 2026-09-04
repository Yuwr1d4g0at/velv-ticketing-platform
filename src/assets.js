const db = require("./db");
const { ASSET_CATEGORIES, ASSET_STATUSES } = require("./constants");

const FIELDS = [
  "name",
  "asset_tag",
  "category",
  "status",
  "assigned_to_name",
  "location",
  "serial_number",
  "vendor",
  "purchase_date",
  "warranty_expires",
  "notes",
];

// For readable audit-trail lines - "Status changed..." rather than
// "status changed...".
const FIELD_LABELS = {
  name: "Name",
  asset_tag: "Asset tag",
  category: "Category",
  status: "Status",
  assigned_to_name: "Assigned to",
  location: "Location",
  serial_number: "Serial number",
  vendor: "Vendor",
  purchase_date: "Purchase date",
  warranty_expires: "Warranty expiry",
  notes: "Notes",
};

// Not retired/lost - the set worth offering on the public request form and
// as the default assignment target. Retired/Lost assets still exist (never
// deleted) and are still reachable/editable from the dashboard, just not
// pushed on requesters picking from a dropdown.
function assignable() {
  return db
    .prepare(
      `SELECT id, name, asset_tag FROM assets
       WHERE status NOT IN ('Retired', 'Lost')
       ORDER BY name`
    )
    .all();
}

function all({ status = "", category = "", q = "" } = {}) {
  let sql = "SELECT * FROM assets WHERE 1 = 1";
  const params = [];
  if (ASSET_STATUSES.includes(status)) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (ASSET_CATEGORIES.includes(category)) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (q.trim()) {
    sql += " AND (name LIKE ? OR asset_tag LIKE ? OR assigned_to_name LIKE ? OR serial_number LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  sql += " ORDER BY CASE status WHEN 'Retired' THEN 1 WHEN 'Lost' THEN 1 ELSE 0 END, name";
  return db.prepare(sql).all(...params);
}

function get(id) {
  return db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
}

function normalize(fields) {
  const out = {};
  for (const key of FIELDS) {
    const raw = (fields[key] || "").toString().trim();
    out[key] = raw ? raw.slice(0, key === "notes" ? 5000 : 200) : null;
  }
  return out;
}

function logActivity(assetId, agentId, body) {
  db.prepare(`INSERT INTO asset_activity (asset_id, agent_id, body) VALUES (?, ?, ?)`).run(assetId, agentId, body);
}

// Returns { error } on validation failure, or { id } on success. agentId may
// be null (e.g. the seed script has no logged-in agent) - asset_activity's
// agent_id is nullable for exactly that reason.
function create(fields, agentId = null) {
  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!ASSET_CATEGORIES.includes(values.category)) return { error: "Choose a valid category." };
  if (values.status && !ASSET_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.asset_tag) {
    const existing = db.prepare("SELECT id FROM assets WHERE asset_tag = ?").get(values.asset_tag);
    if (existing) return { error: `Asset tag "${values.asset_tag}" is already in use.` };
  }

  const result = db
    .prepare(
      `INSERT INTO assets (name, asset_tag, category, status, assigned_to_name, location, serial_number, vendor, purchase_date, warranty_expires, notes)
       VALUES (@name, @asset_tag, @category, @status, @assigned_to_name, @location, @serial_number, @vendor, @purchase_date, @warranty_expires, @notes)`
    )
    .run({ ...values, status: values.status || "In Use" });
  logActivity(result.lastInsertRowid, agentId, "Asset created.");
  return { id: result.lastInsertRowid };
}

// Diffs the incoming values against what's currently stored and logs one
// readable line per field that actually changed - a save that changes
// nothing logs nothing, and a save that changes three fields logs three
// distinct lines rather than one opaque "asset updated".
function update(id, fields, agentId = null) {
  const before = get(id);
  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!ASSET_CATEGORIES.includes(values.category)) return { error: "Choose a valid category." };
  if (!ASSET_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.asset_tag) {
    const existing = db.prepare("SELECT id FROM assets WHERE asset_tag = ? AND id != ?").get(values.asset_tag, id);
    if (existing) return { error: `Asset tag "${values.asset_tag}" is already in use.` };
  }

  db.prepare(
    `UPDATE assets SET
       name = @name, asset_tag = @asset_tag, category = @category, status = @status,
       assigned_to_name = @assigned_to_name, location = @location, serial_number = @serial_number,
       vendor = @vendor, purchase_date = @purchase_date, warranty_expires = @warranty_expires,
       notes = @notes, updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...values, id });

  if (before) {
    for (const key of FIELDS) {
      if ((before[key] || null) === (values[key] || null)) continue;
      const label = FIELD_LABELS[key];
      const from = before[key] || "(empty)";
      const to = values[key] || "(empty)";
      logActivity(id, agentId, key === "notes" ? "Notes updated." : `${label} changed from "${from}" to "${to}".`);
    }
  }
  return { id };
}

function ticketsForAsset(assetId) {
  return db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.status, tickets.priority, tickets.created_at
       FROM tickets WHERE asset_id = ? ORDER BY created_at DESC`
    )
    .all(assetId);
}

function activityForAsset(assetId) {
  return db
    .prepare(
      `SELECT asset_activity.*, agents.name AS agent_name
       FROM asset_activity
       LEFT JOIN agents ON agents.id = asset_activity.agent_id
       WHERE asset_id = ?
       ORDER BY created_at ASC`
    )
    .all(assetId);
}

module.exports = { assignable, all, get, create, update, ticketsForAsset, activityForAsset };
