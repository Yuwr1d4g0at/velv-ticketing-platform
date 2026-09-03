/* Dashboard ticket list only - the "select all" checkbox and the live
   selected-count label. No-ops everywhere else. */
(function () {
  var selectAll = document.getElementById("select-all");
  var countLabel = document.getElementById("bulk-count");
  if (!selectAll) return;

  var rowBoxes = function () { return document.querySelectorAll(".row-select"); };

  function updateCount() {
    var checked = document.querySelectorAll(".row-select:checked").length;
    if (countLabel) countLabel.textContent = String(checked);
  }

  selectAll.addEventListener("change", function () {
    rowBoxes().forEach(function (cb) { cb.checked = selectAll.checked; });
    updateCount();
  });

  rowBoxes().forEach(function (cb) {
    cb.addEventListener("change", function () {
      if (!cb.checked) selectAll.checked = false;
      updateCount();
    });
  });

  updateCount();
})();
