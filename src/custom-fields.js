// Field definitions scoped to one category (e.g. a "System name" field that
// only makes sense on Account & Access tickets). Text-only for now - a
// full type system (number/date/select with options) is real added
// complexity for a first version; text covers the common cases (an ID, a
// system name, an order number) without it.
const db = require("./db");

function definitionsForCategory(category) {
  return db.prepare("SELECT * FROM custom_field_definitions WHERE category = ? ORDER BY field_name").all(category);
}

function allDefinitions() {
  return db.prepare("SELECT * FROM custom_field_definitions ORDER BY category, field_name").all();
}

// Grouped by category, for rendering every category's fields into a form
// up front (one group per category, shown/hidden client-side as the
// category select changes) rather than querying per category.
function byCategory() {
  const grouped = {};
  for (const def of allDefinitions()) {
    (grouped[def.category] = grouped[def.category] || []).push(def);
  }
  return grouped;
}

function create(category, fieldName) {
  const name = (fieldName || "").trim().slice(0, 100);
  if (!name) return { error: "Field name is required." };
  db.prepare("INSERT INTO custom_field_definitions (category, field_name) VALUES (?, ?)").run(category, name);
  return {};
}

function remove(id) {
  db.prepare("DELETE FROM custom_field_definitions WHERE id = ?").run(id);
}

// Reads custom_<field id> out of a submitted form body and saves them for
// a ticket - scoped to the given category's OWN field definitions, not
// whatever custom_* keys happen to be present. The category select's
// hidden/shown groups already keep a well-behaved client from submitting
// another category's fields, but this re-derives the valid id set
// server-side rather than trusting that - a crafted request could submit
// custom_<id> for a field belonging to a different category otherwise, and
// there's no per-ticket reason for that value to exist.
function saveSubmittedCustomFields(ticketId, category, body) {
  const definitions = definitionsForCategory(category);
  if (!definitions.length) return;
  const upsert = db.prepare(
    `INSERT INTO ticket_custom_values (ticket_id, field_definition_id, value) VALUES (?, ?, ?)
     ON CONFLICT (ticket_id, field_definition_id) DO UPDATE SET value = excluded.value`
  );
  for (const def of definitions) {
    const raw = body[`custom_${def.id}`];
    const value = (raw || "").toString().trim().slice(0, 500);
    if (value) upsert.run(ticketId, def.id, value);
  }
}

function valuesForTicket(ticketId) {
  return db
    .prepare(
      `SELECT custom_field_definitions.field_name, ticket_custom_values.value
       FROM ticket_custom_values
       JOIN custom_field_definitions ON custom_field_definitions.id = ticket_custom_values.field_definition_id
       WHERE ticket_custom_values.ticket_id = ?
       ORDER BY custom_field_definitions.field_name`
    )
    .all(ticketId);
}

module.exports = { definitionsForCategory, allDefinitions, byCategory, create, remove, saveSubmittedCustomFields, valuesForTicket };
