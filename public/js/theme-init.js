/* Runs synchronously in <head>, before the page paints, so there is no
   flash of the wrong theme. Kept tiny and dependency-free on purpose. */
(function () {
  try {
    if (localStorage.getItem("velv-theme") === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch (e) {
    // localStorage unavailable (private mode, etc.) — default to light.
  }
})();
