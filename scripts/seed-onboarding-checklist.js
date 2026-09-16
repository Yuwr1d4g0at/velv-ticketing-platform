// One-off, run-once-by-hand script (like the other scripts/seed-*.js files)
// - creates the actual "New Hire Onboarding" template the domain-automation
// feature was built for. That work added the *capability* (checklist items
// on a template, some flagged to spawn a ticket in another department) and
// tested it with synthetic data, but never created a real template using it.
require("dotenv").config();
const db = require("../src/db");
const checklists = require("../src/checklists");

const existing = db.prepare("SELECT id FROM ticket_templates WHERE name = ?").get("New Hire Onboarding");
if (existing) {
  console.log(`"New Hire Onboarding" already exists (template id ${existing.id}) - not creating a duplicate.`);
  process.exit(0);
}

const result = db
  .prepare("INSERT INTO ticket_templates (name, category, subject, description) VALUES (?, ?, ?, ?)")
  .run(
    "New Hire Onboarding",
    "Onboarding",
    "New hire onboarding",
    "Standard onboarding checklist for a new hire. Set this ticket's requester name/email to the new hire's own details before submitting - the checklist items below use {name} and it's also what the spawned IT/Marketing tickets will be filed under."
  );
const templateId = result.lastInsertRowid;

// Order matters here (position, set automatically by addChecklistItem in
// the order called) - plain HR items first, then the two spawn-flagged
// ones from the feature's own example (a PC for IT, a profile picture for
// Marketing).
const items = [
  { label: "Send welcome email and collect signed offer paperwork" }, // plain - HR only, no spawn
  { label: "Configure PC for {name}", spawnCategory: "Hardware" }, // -> IT
  { label: "Create company profile picture for {name}", spawnCategory: "Brand Assets" }, // -> Marketing
  { label: "Schedule benefits enrollment session" }, // plain - HR only, no spawn
];

for (const item of items) {
  const added = checklists.addChecklistItem(templateId, item);
  if (added.error) throw new Error(`Adding checklist item "${item.label}": ${added.error}`);
}

console.log(`Created template "New Hire Onboarding" (id ${templateId}) with ${items.length} checklist items:`);
checklists.itemsForTemplate(templateId).forEach((i) => {
  console.log(`  - ${i.label}${i.spawn_category ? ` -> spawns a ${i.spawn_category} ticket` : ""}`);
});
console.log("\nTo try it: Dashboard -> New ticket -> pick this template -> set the requester name to a real-looking new hire -> submit. Check the spawned IT and Marketing tickets, and that HR's own ticket shows them as linked.");
