const CATEGORIES = ["Hardware", "Software", "Network", "Account & Access", "Other"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

// A still-open ticket (Open or In Progress) older than this gets an "Aging"
// flag on the dashboard, so nothing quietly falls through the cracks.
const AGING_DAYS = 5;

// Tickets per dashboard page.
const PAGE_SIZE = 25;

module.exports = { CATEGORIES, PRIORITIES, STATUSES, AGING_DAYS, PAGE_SIZE };
