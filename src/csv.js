// Minimal CSV serialization - no dependency needed for something this small.
function escapeCell(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// rows: array of objects. columns: [{ key, header }] in output order.
function toCsv(rows, columns) {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c.key])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { toCsv };
