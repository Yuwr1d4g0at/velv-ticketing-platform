const CATEGORIES = ["Hardware", "Software", "Network", "Account & Access", "Other"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

// A still-open ticket (Open or In Progress) older than this gets an "Aging"
// flag on the dashboard, so nothing quietly falls through the cracks. Scaled
// by priority - an Urgent ticket sitting for 2 days is worse than a Low one
// sitting for 5, so they shouldn't share one flat threshold.
const AGING_DAYS_BY_PRIORITY = { Urgent: 1, High: 2, Medium: 5, Low: 7 };

// Tickets per dashboard page.
const PAGE_SIZE = 25;

const ASSET_CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Server", "Network Equipment", "Peripheral", "Software License", "Other"];
const ASSET_STATUSES = ["Available", "Reserved", "In Use", "In Storage", "Under Repair", "Retired", "Lost"];

module.exports = {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  AGING_DAYS_BY_PRIORITY,
  PAGE_SIZE,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
};
