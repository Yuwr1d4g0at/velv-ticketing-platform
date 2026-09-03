// File attachments for tickets: upload handling, storage, and lookup helpers.
//
// Security notes (this is the one part of the app that touches the filesystem
// with user-supplied content, so it gets extra care):
//   - On-disk filenames are always server-generated random hex + an extension
//     from ALLOWED_TYPES below - never derived from the uploaded filename. That
//     rules out path traversal and disguising an executable with a safe-looking
//     name; the user's original filename is kept only as a DB column for display.
//   - Only a fixed allowlist of mime types can be uploaded (images, PDF, plain
//     text, CSV). Notably no .svg or .html - both can carry a <script>, and
//     serving one back would be a stored-XSS hole.
//   - Downloads always come back as `Content-Disposition: attachment`, so even
//     a mislabeled file gets saved to disk rather than rendered/executed by the
//     browser. That means no inline image thumbnails, which is a fair trade for
//     one less thing that has to be airtight.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("./db");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "tickets.sqlite");
const ATTACHMENTS_DIR = path.join(path.dirname(DB_PATH), "attachments");
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 3; // per upload action (a new ticket, or one note)

const ALLOWED_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ATTACHMENTS_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || "";
    cb(null, `${crypto.randomBytes(24).toString("hex")}${ext}`);
  },
});

const multerUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
    cb(null, true);
  },
});

const LIMITS_HINT = `Optional, up to ${MAX_FILES} files, ${MAX_FILE_BYTES / (1024 * 1024)} MB each. Images, PDF, TXT, or CSV.`;

// Wraps multer so a bad upload (wrong type, too big, too many files) turns into
// a friendly `req.uploadError` string instead of a thrown error - the caller
// re-renders the same form with it, same as any other validation error. Also
// cleans up any files multer already wrote to disk before it hit the error,
// so a rejected request never leaves orphaned files behind.
function handleUpload(fieldName) {
  const middleware = multerUpload.array(fieldName, MAX_FILES);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

      for (const file of req.files || []) {
        fs.unlink(file.path, () => {});
      }

      if (err.code === "LIMIT_FILE_SIZE") {
        req.uploadError = `Each file must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
      } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        req.uploadError = `You can attach up to ${MAX_FILES} files.`;
      } else if (err.message === "UNSUPPORTED_FILE_TYPE") {
        req.uploadError = "Unsupported file type. Allowed: images, PDF, TXT, or CSV.";
      } else {
        req.uploadError = "Could not upload the attached file(s). Please try again.";
      }
      next();
    });
  };
}

function saveAttachments({ ticketId, files, uploadedBy, agentId = null }) {
  if (!files || !files.length) return [];
  const insert = db.prepare(
    `INSERT INTO attachments (ticket_id, stored_name, original_name, mime_type, size_bytes, uploaded_by, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  return files.map((file) => {
    const result = insert.run(
      ticketId,
      file.filename,
      file.originalname.slice(0, 200),
      file.mimetype,
      file.size,
      uploadedBy,
      agentId
    );
    return result.lastInsertRowid;
  });
}

function deleteUploadedFiles(files) {
  for (const file of files || []) {
    fs.unlink(file.path, () => {});
  }
}

function attachmentsForTicket(ticketId) {
  return db
    .prepare(
      `SELECT attachments.*, agents.name AS agent_name
       FROM attachments
       LEFT JOIN agents ON agents.id = attachments.agent_id
       WHERE ticket_id = ?
       ORDER BY created_at ASC`
    )
    .all(ticketId);
}

function getAttachment(ticketId, attachmentId) {
  return db
    .prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ?")
    .get(attachmentId, ticketId);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  ATTACHMENTS_DIR,
  MAX_FILE_BYTES,
  MAX_FILES,
  LIMITS_HINT,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getAttachment,
  formatSize,
};
