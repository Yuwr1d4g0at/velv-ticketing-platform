/* The notification bell's dropdown is a plain <details>/<summary> (see
   views/partials/header.ejs) - no JS needed for open/close. This only
   listens for the "toggle" event to mark everything read the instant it's
   opened, and zeroes the badge optimistically rather than waiting for a
   round trip. No-ops if the page has no bell (public pages, logged out). */
(function () {
  var bell = document.querySelector(".notif-bell");
  if (!bell) return;

  bell.addEventListener("toggle", function () {
    if (!bell.open) return;
    var badge = bell.querySelector(".notif-badge");
    if (badge) badge.remove();
    bell.querySelectorAll(".notif-item.is-unread").forEach(function (item) {
      item.classList.remove("is-unread");
    });

    fetch("/dashboard/notifications/mark-all-read", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "_csrf=" + encodeURIComponent(bell.dataset.csrf || ""),
    }).catch(function () {
      /* Best-effort - worst case the badge reappears on next page load. */
    });
  });
})();
