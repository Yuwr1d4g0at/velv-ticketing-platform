/* Wires up the "Lights" switch in the header. Runs at the end of the
   body, once the toggle markup already exists. */
(function () {
  var toggle = document.getElementById("lights-switch");
  if (!toggle) return;

  var isDark = document.documentElement.getAttribute("data-theme") === "dark";
  toggle.checked = !isDark;

  toggle.addEventListener("change", function () {
    var dark = !toggle.checked;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try {
      localStorage.setItem("velv-theme", dark ? "dark" : "light");
    } catch (e) {
      // localStorage unavailable — theme just won't persist across visits.
    }
  });
})();
