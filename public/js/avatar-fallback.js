// Hides a .directory-avatar <img> if it 404s (no photo on file for that
// person, or Graph unavailable) - a broken-image icon looks worse than no
// avatar at all. CSP has no unsafe-inline, so this can't be a plain
// onerror="..." attribute - a delegated capture-phase listener instead,
// since the "error" event on an <img> doesn't bubble.
document.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains("directory-avatar")) {
      e.target.style.display = "none";
    }
  },
  true
);
