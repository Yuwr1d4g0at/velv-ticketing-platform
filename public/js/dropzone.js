/* Progressive enhancement for a file input: wraps it in a drag-and-drop
   target and shows a removable preview list of the currently-selected
   files. The underlying <input type="file"> stays the real source of
   truth for what actually submits - this only ever reassigns its .files
   (via the DataTransfer API, since FileList itself is read-only), so a
   browser with JS disabled just sees a plain working file input. */
(function () {
  document.querySelectorAll("input[type=file][data-dropzone]").forEach(function (input) {
    var wrapper = document.createElement("div");
    wrapper.className = "dropzone";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    var hint = document.createElement("p");
    hint.className = "dropzone-hint";
    hint.textContent = "Drag files here, or use the button above.";
    wrapper.appendChild(hint);

    var list = document.createElement("ul");
    list.className = "dropzone-list";
    wrapper.appendChild(list);

    function renderList() {
      list.textContent = "";
      Array.from(input.files || []).forEach(function (file, index) {
        var item = document.createElement("li");
        var name = document.createElement("span");
        name.textContent = file.name;
        item.appendChild(name);

        var remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove " + file.name);
        remove.addEventListener("click", function () {
          var transfer = new DataTransfer();
          Array.from(input.files).forEach(function (f, i) {
            if (i !== index) transfer.items.add(f);
          });
          input.files = transfer.files;
          renderList();
        });
        item.appendChild(remove);
        list.appendChild(item);
      });
    }

    input.addEventListener("change", renderList);

    ["dragenter", "dragover"].forEach(function (eventName) {
      wrapper.addEventListener(eventName, function (e) {
        e.preventDefault();
        wrapper.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      wrapper.addEventListener(eventName, function (e) {
        e.preventDefault();
        wrapper.classList.remove("is-dragover");
      });
    });
    wrapper.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        renderList();
      }
    });

    renderList();
  });
})();
