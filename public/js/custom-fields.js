/* Shows only the custom-field group matching the currently-selected
   category (see the [data-custom-fields] groups on the public request form
   and the agent new-ticket form) - runs on load too, so a validation-error
   re-render with a category already chosen shows the right group
   immediately, not just after the visitor touches the select again. */
(function () {
  var categorySelect = document.getElementById("category");
  var groups = document.querySelectorAll("[data-custom-fields]");
  if (!categorySelect || !groups.length) return;

  function sync() {
    groups.forEach(function (group) {
      group.hidden = group.dataset.customFields !== categorySelect.value;
    });
  }

  categorySelect.addEventListener("change", sync);
  sync();
})();
