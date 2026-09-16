// Departments + department-scoped categories, and the one place that
// decides whether an agent can see a given ticket.
//
// This exact feature shipped once before and was fully reverted the same
// day: visibility had a quiet carve-out ("you can still see a ticket you're
// personally assigned to or watching, even outside your department"), and
// because the only two real test tickets happened to both be assigned to
// the one agent testing it, switching that agent's department appeared to
// do nothing - the carve-out always won. It passed every automated test
// written for it (synthetic multi-department fixtures that never exercised
// that gap) and still shipped broken.
//
// canSeeTicket() below has NO such carve-out for a regular agent: it's a
// strict department match, full stop. Confidentiality (see tickets.
// confidential) only ever narrows what a same-department agent can see,
// never widens it across departments. The ONLY bypass is agents.is_admin -
// a real, visible, opt-in role (shown on the Agents page), never a default
// anyone quietly ends up with.
const db = require("./db");

function all() {
  return db.prepare("SELECT * FROM departments WHERE active = 1 ORDER BY name").all();
}

function allIncludingInactive() {
  return db.prepare("SELECT * FROM departments ORDER BY active DESC, name").all();
}

function get(id) {
  return db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
}

function create(name) {
  const trimmed = (name || "").trim().slice(0, 100);
  if (!trimmed) return { error: "Name is required." };
  const existing = db.prepare("SELECT id FROM departments WHERE name = ? COLLATE NOCASE").get(trimmed);
  if (existing) return { error: "A department with that name already exists." };
  const result = db.prepare("INSERT INTO departments (name) VALUES (?)").run(trimmed);
  return { id: result.lastInsertRowid };
}

function setActive(id, active) {
  db.prepare("UPDATE departments SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

// ---- Categories ----------------------------------------------------------

function categoriesAll() {
  return db
    .prepare(
      `SELECT categories.*, departments.name AS department_name
       FROM categories JOIN departments ON departments.id = categories.department_id
       WHERE categories.active = 1
       ORDER BY departments.name, categories.name`
    )
    .all();
}

function allCategoriesIncludingInactive() {
  return db
    .prepare(
      `SELECT categories.*, departments.name AS department_name
       FROM categories JOIN departments ON departments.id = categories.department_id
       ORDER BY categories.active DESC, departments.name, categories.name`
    )
    .all();
}

// Flat list of category names - the direct replacement for the old
// CATEGORIES constant everywhere a plain "is this a valid category" check
// or an unstructured <select> needs one. The public request form
// deliberately still uses this unfiltered list (department-specific public
// intake is explicitly out of scope for this feature) - only the
// dashboard's own views group categories by department.
function categoryNames() {
  return categoriesAll().map((c) => c.name);
}

// Same categories, grouped by department name - for dashboard views that
// present categories scoped to one department at a time (custom fields,
// automation, templates, recurring tickets).
function categoriesByDepartment() {
  const grouped = {};
  for (const c of categoriesAll()) {
    (grouped[c.department_name] = grouped[c.department_name] || []).push(c);
  }
  return grouped;
}

function isValidCategoryName(name) {
  return Boolean(db.prepare("SELECT 1 FROM categories WHERE name = ? AND active = 1").get(name));
}

function departmentIdForCategory(name) {
  const row = db.prepare("SELECT department_id FROM categories WHERE name = ?").get(name);
  return row ? row.department_id : null;
}

function createCategory(name, departmentId) {
  const trimmed = (name || "").trim().slice(0, 100);
  if (!trimmed) return { error: "Category name is required." };
  const dept = get(departmentId);
  if (!dept) return { error: "Choose a valid department." };
  const existing = db.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE").get(trimmed);
  if (existing) return { error: "A category with that name already exists." };
  const result = db.prepare("INSERT INTO categories (name, department_id) VALUES (?, ?)").run(trimmed, departmentId);
  return { id: result.lastInsertRowid };
}

function setCategoryActive(id, active) {
  db.prepare("UPDATE categories SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

// ---- Approval gate ---------------------------------------------------------

// Whether closing a ticket filed under `categoryName` has to go through the
// approval gate (see applyStatusChange in src/routes/dashboard.js) instead of
// closing directly. Off by default for every category - see the
// requires_approval migration in src/db/index.js, which flips it on for
// Marketing's Content & Design and Campaign Request out of the box, and
// leaves every other category (including everything that predates this
// feature) closing exactly as it always has.
function categoryRequiresApproval(categoryName) {
  const row = db.prepare("SELECT requires_approval FROM categories WHERE name = ?").get(categoryName);
  return Boolean(row && row.requires_approval);
}

function setCategoryRequiresApproval(id, requiresApproval) {
  db.prepare("UPDATE categories SET requires_approval = ? WHERE id = ?").run(requiresApproval ? 1 : 0, id);
}

// ---- Ticket visibility ----------------------------------------------------

// Whether `agent` can see `ticket`. `agent` needs at least
// {id, department_id, is_admin}; `ticket` needs at least
// {category, confidential, assigned_to}. See the file comment above for
// why there is deliberately no assignment/watcher carve-out here.
function canSeeTicket(agent, ticket) {
  if (!agent) return false;
  if (agent.is_admin) return true;
  const ticketDeptId = departmentIdForCategory(ticket.category);
  if (ticketDeptId == null || ticketDeptId !== agent.department_id) return false;
  if (ticket.confidential) return ticket.assigned_to === agent.id;
  return true;
}

// The SQL equivalent of canSeeTicket(), for filtering a list/count/CSV/
// report query at the database level instead of fetching everything and
// filtering in application code. Assumes the query already makes an
// unaliased `tickets` table available (every caller in this app does).
// Returns an empty fragment for an admin - nothing to restrict.
function ticketVisibilitySql(agent) {
  if (!agent || agent.is_admin) return { sql: "", params: [] };
  return {
    sql: ` AND tickets.category IN (SELECT name FROM categories WHERE department_id = ?) AND (tickets.confidential = 0 OR tickets.assigned_to = ?)`,
    params: [agent.department_id, agent.id],
  };
}

// Whether `assignee` is allowed to be assigned a ticket filed under
// `categoryName`. An admin can be assigned anything; anyone else has to
// actually belong to that category's department. Used for both automatic
// (round-robin, on ticket creation) and manual (agent-initiated ticket,
// single/bulk assign) assignment, so "only agents in that department are
// eligible" is one rule enforced everywhere, not a policy that quietly
// differs by how the assignment happens.
function isEligibleAssignee(assignee, categoryName) {
  if (!assignee) return false;
  if (assignee.is_admin) return true;
  return assignee.department_id === departmentIdForCategory(categoryName);
}

module.exports = {
  all,
  allIncludingInactive,
  get,
  create,
  setActive,
  categoriesAll,
  allCategoriesIncludingInactive,
  categoryNames,
  categoriesByDepartment,
  isValidCategoryName,
  departmentIdForCategory,
  createCategory,
  setCategoryActive,
  categoryRequiresApproval,
  setCategoryRequiresApproval,
  canSeeTicket,
  ticketVisibilitySql,
  isEligibleAssignee,
};
