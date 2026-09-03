/* Ticket detail page only - the "Insert a canned response" select. No-ops
   everywhere else (the element just won't exist on other pages). */
(function () {
  var select = document.getElementById("canned-select");
  if (!select) return;

  select.addEventListener("change", function () {
    if (!select.value) return;
    var target = document.getElementById(select.dataset.target);
    if (target) target.value = select.value;
    select.selectedIndex = 0;
    if (target) target.focus();
  });
})();
