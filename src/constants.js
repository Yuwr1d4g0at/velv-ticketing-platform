const CATEGORIES = ["Hardware", "Software", "Network", "Account & Access", "Other"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

// Aging thresholds by priority live in the sla_thresholds table now (see
// src/aging.js) - editable from /dashboard/settings, no longer a hardcoded
// constant. The historical defaults it's seeded with on first boot are in
// src/db/index.js's DEFAULT_SLA_DAYS, right next to the seeding logic.

// Tickets per dashboard page.
const PAGE_SIZE = 25;

const ASSET_CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Server", "Network Equipment", "Peripheral", "Software License", "Other"];
const ASSET_STATUSES = ["Available", "Reserved", "In Use", "In Storage", "Under Repair", "Retired", "Lost"];

module.exports = {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  PAGE_SIZE,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
};
