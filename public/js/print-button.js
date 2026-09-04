/* Wires up the "Print / Save as PDF" button on the ticket print view. CSP
   blocks inline onclick, so this has to be an external file. */
(function () {
  var button = document.getElementById("print-button");
  if (!button) return;
  button.addEventListener("click", function () {
    window.print();
  });
})();
