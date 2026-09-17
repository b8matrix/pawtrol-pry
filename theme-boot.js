// Loaded synchronously in <head> so the right theme paints on first frame.
// data-theme = the user's explicit choice ("light" | "dark"), absent = system.
// data-scheme = the resolved scheme the CSS actually keys off.
(function () {
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() {
    try {
      var v = localStorage.getItem("pry-theme");
      return v === "light" || v === "dark" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function apply() {
    var choice = stored();
    if (choice) root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
    root.setAttribute("data-scheme", choice || (media.matches ? "dark" : "light"));
  }

  apply();
  media.addEventListener("change", apply);
  // Another extension page (side panel ↔ settings) changed the theme.
  window.addEventListener("storage", function (e) {
    if (e.key === "pry-theme") apply();
  });
  window.__pryApplyTheme = apply;
})();
