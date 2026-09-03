// One-off (but re-runnable) import of the IT hardware inventory exported
// from SharePoint ("Hardware Inventory" list, "Stock Status" view -> Export
// to CSV) into this app's own `assets` table.
//
// Usage: node scripts/import-assets.js <path-to-csv> [--commit]
// Without --commit, this only parses and reports what WOULD happen (dry
// run) - nothing is written to the database. Pass --commit to actually
// insert.
//
// The source list's columns don't map 1:1 onto ours, so this file documents
// the mapping explicitly rather than hiding it in generic code - see
// CATEGORY_MAP / STATUS_MAP below. Re-run against a fresher export later if
// the inventory changes; already-imported rows (matched by the synthetic
// "HW-<source ID>" asset tag) are skipped rather than duplicated.

const fs = require("fs");
const db = require("../src/db");
const assets = require("../src/assets");

const SOURCE_CATEGORY_MAP = {
  "computador portátil": "Laptop",
  monitor: "Monitor",
  smartphone: "Phone",
  switch: "Network Equipment",
  teclado: "Peripheral",
  rato: "Peripheral",
  headphones: "Peripheral",
  "adaptador usb": "Peripheral",
};

const SOURCE_STATUS_MAP = {
  available: "Available",
  reserved: "Reserved",
  "in use": "In Use",
  "in repair": "Under Repair",
  retired: "Retired",
};

// Minimal RFC4180 CSV parser: handles quoted fields, embedded commas,
// escaped `""` quotes, and embedded newlines inside quoted fields (the
// source has none of the last, but no reason to assume that always holds).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

function ddmmyyyyToIso(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw || "").trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function orNull(raw) {
  const v = (raw || "").trim();
  if (!v || /^n\/?a-?$/i.test(v)) return null;
  return v;
}

function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) {
    console.error("Usage: node scripts/import-assets.js <path-to-csv> [--commit]");
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(raw);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const dataRows = rows.slice(1);

  const stats = { total: dataRows.length, created: 0, skippedExisting: 0, failed: [] };
  const unmappedCategories = new Set();
  const unmappedStatuses = new Set();

  for (const cells of dataRows) {
    const col = (name) => cells[idx[name]] || "";
    const sourceId = col("ID").trim();
    const assetTag = `HW-${sourceId}`;

    // create() would also reject a duplicate asset_tag, but checking here
    // gives a clearer "already imported" message and lets a re-run be a
    // no-op for rows that succeeded last time, rather than a wall of errors.
    const existing = db.prepare("SELECT id FROM assets WHERE asset_tag = ?").get(assetTag);
    if (existing) {
      stats.skippedExisting++;
      continue;
    }

    const brand = orNull(col("Brand"));
    const model = orNull(col("Model"));
    const name = [brand, model].filter(Boolean).join(" ") || `Asset ${sourceId}`;

    const sourceCategory = col("Asset Type").trim();
    const categoryKey = sourceCategory.toLowerCase();
    let category = SOURCE_CATEGORY_MAP[categoryKey];
    if (!category) {
      category = "Other";
      if (sourceCategory) unmappedCategories.add(sourceCategory);
    }

    const sourceStatus = col("Status").trim();
    let status = SOURCE_STATUS_MAP[sourceStatus.toLowerCase()];
    if (!status) {
      status = "In Use";
      if (sourceStatus) unmappedStatuses.add(sourceStatus);
    }

    const noteParts = [];
    // "Condition Notes" and "Asset Specs" are both, on every row in this
    // export, just a "View Entries" link back to the SharePoint item -
    // never actual free text - so neither is worth importing.
    const assignedDate = orNull(col("Assigned Date"));
    if (assignedDate) noteParts.push(`Assigned: ${assignedDate}`);
    const previousOwner = orNull(col("Previous Owner"));
    if (previousOwner) noteParts.push(`Previous owner: ${previousOwner}`);
    const purchasePrice = orNull(col("Purchase Price"));
    if (purchasePrice) noteParts.push(`Purchase price: ${purchasePrice}`);
    // SharePoint's own CSV export percent-encodes "#" in this column's header.
    const orderVot = orNull(col("Order %23VOT"));
    if (orderVot) noteParts.push(`Order: ${orderVot}`);
    const riskLevel = orNull(col("Risk Level"));
    if (riskLevel) noteParts.push(`Risk level: ${riskLevel}`);
    noteParts.push(`Imported from SharePoint Hardware Inventory, source ID ${sourceId}.`);

    const fields = {
      name,
      asset_tag: assetTag,
      category,
      status,
      assigned_to_name: orNull(col("Current Owner")),
      location: null,
      serial_number: orNull(col("Serial Number")),
      vendor: brand,
      purchase_date: ddmmyyyyToIso(col("Purchase Date")),
      warranty_expires: null,
      notes: noteParts.join("\n"),
    };

    if (commit) {
      const result = assets.create(fields);
      if (result.error) {
        stats.failed.push({ sourceId, name, error: result.error });
      } else {
        stats.created++;
      }
    } else {
      stats.created++; // would-create, in dry-run terms
    }
  }

  console.log(`${commit ? "IMPORT" : "DRY RUN"} - ${csvPath}`);
  console.log(`  Source rows:        ${stats.total}`);
  console.log(`  ${commit ? "Created" : "Would create"}:      ${stats.created}`);
  console.log(`  Already imported:   ${stats.skippedExisting} (matched by asset tag)`);
  console.log(`  Failed:             ${stats.failed.length}`);
  if (stats.failed.length) {
    for (const f of stats.failed) console.log(`    - HW-${f.sourceId} "${f.name}": ${f.error}`);
  }
  if (unmappedCategories.size) {
    console.log(`  Unmapped Asset Type values (filed under "Other"): ${[...unmappedCategories].join(", ")}`);
  }
  if (unmappedStatuses.size) {
    console.log(`  Unmapped Status values (filed under "In Use"): ${[...unmappedStatuses].join(", ")}`);
  }
  if (!commit) {
    console.log("\nDry run only - nothing written. Re-run with --commit to actually import.");
  }
}

main();
