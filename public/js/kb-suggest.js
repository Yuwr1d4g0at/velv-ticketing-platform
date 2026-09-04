/* As a requester types a subject on the request form, suggest matching
   published KB articles below the field - deflects a ticket that
   self-service could already answer. Debounced so it's one request per
   pause in typing, not one per keystroke. No-ops if the page has no
   subject field or suggestion box (dashboard forms don't have either). */
(function () {
  var subjectField = document.getElementById("subject");
  var box = document.getElementById("kb-suggestions");
  if (!subjectField || !box) return;

  var timer = null;

  function render(articles) {
    if (!articles.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      '<p class="field-hint">This might already answer it:</p><ul>' +
      articles
        .map(function (a) {
          var link = document.createElement("a");
          link.href = "/kb/" + encodeURIComponent(a.slug);
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = a.title;
          return "<li>" + link.outerHTML + "</li>";
        })
        .join("") +
      "</ul>";
    box.hidden = false;
  }

  subjectField.addEventListener("input", function () {
    clearTimeout(timer);
    var q = subjectField.value.trim();
    if (q.length < 3) {
      render([]);
      return;
    }
    timer = setTimeout(function () {
      fetch("/kb/suggest.json?q=" + encodeURIComponent(q))
        .then(function (res) { return res.ok ? res.json() : []; })
        .then(render)
        .catch(function () { render([]); });
    }, 300);
  });
})();
