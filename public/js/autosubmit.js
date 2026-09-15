/* Any field with [data-autosubmit] submits its enclosing form the moment it
   changes - for an inline picker in a table row (e.g. the Agents page's
   per-row department <select> and admin checkbox) that should save on
   change without a separate "Save" click. CSP has no unsafe-inline, so this
   can't be a plain onchange="..." attribute - a plain listener from this
   external file instead. Uses requestSubmit() (not submit()) so a normal
   HTML form submission still fires (respecting method/action, and any other
   submit-time behavior), it just does so automatically. */
(function () {
  document.querySelectorAll("[data-autosubmit]").forEach(function (field) {
    field.addEventListener("change", function () {
      if (field.form) field.form.requestSubmit();
    });
  });
})();
