/* Ticket detail page only - the "Link a help article" select appends the
   article's URL to the note textarea (doesn't replace it, unlike the canned-
   response select - an agent picking this has usually already written part
   of their reply). No-ops everywhere else. */
(function () {
  var select = document.getElementById("kb-select");
  if (!select) return;

  select.addEventListener("change", function () {
    if (!select.value) return;
    var target = document.getElementById(select.dataset.target);
    if (target) {
      target.value = target.value ? `${target.value}\n${select.value}` : select.value;
      target.focus();
    }
    select.selectedIndex = 0;
  });
})();
