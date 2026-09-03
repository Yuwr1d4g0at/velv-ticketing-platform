/* Generic show/hide toggle: a button with data-toggle="some-id" shows/hides
   the element with that id and flips its own label between data-label-show
   and data-label-hide. No-ops if the page has no such button. */
(function () {
  document.querySelectorAll("[data-toggle]").forEach(function (button) {
    var panel = document.getElementById(button.dataset.toggle);
    if (!panel) return;

    button.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      if (button.dataset.labelShow && button.dataset.labelHide) {
        button.textContent = panel.hidden ? button.dataset.labelShow : button.dataset.labelHide;
      }
      if (!panel.hidden) {
        var firstField = panel.querySelector("input, select, textarea");
        if (firstField) firstField.focus();
      }
    });
  });
})();
