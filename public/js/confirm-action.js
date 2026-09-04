/* A form with data-confirm="..." shows a native confirm() dialog before
   submitting - for actions that are destructive/hard to reverse (GDPR
   erasure, merging a ticket away). CSP blocks inline onsubmit handlers, so
   this has to be wired up from an external file. */
(function () {
  document.querySelectorAll("form[data-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.dataset.confirm)) {
        event.preventDefault();
      }
    });
  });
})();
