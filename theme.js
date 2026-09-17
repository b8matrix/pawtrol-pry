// Theme controls: the header toggle ([data-theme-toggle]) and the
// System / Light / Dark radios in Settings (input[name="pry-theme"]).

const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function readChoice() {
  try {
    const v = localStorage.getItem("pry-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function writeChoice(choice) {
  try {
    if (choice === "system") localStorage.removeItem("pry-theme");
    else localStorage.setItem("pry-theme", choice);
  } catch {
    /* storage blocked: the change still applies to this page */
  }
}

function syncControls() {
  const choice = readChoice();
  const scheme = root.getAttribute("data-scheme");
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    const next = scheme === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
  });
  document.querySelectorAll('input[name="pry-theme"]').forEach((r) => {
    r.checked = r.value === choice;
  });
}

// Circular reveal from the control that was pressed.
function setTheme(choice, origin) {
  const run = () => {
    writeChoice(choice);
    if (choice === "system") root.removeAttribute("data-theme");
    window.__pryApplyTheme?.();
    if (choice !== "system") {
      root.setAttribute("data-theme", choice);
      root.setAttribute("data-scheme", choice);
    }
    syncControls();
  };

  if (!document.startViewTransition || reduceMotion.matches || !origin) {
    run();
    return;
  }

  const rect = origin.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  const transition = document.startViewTransition(run);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}

document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = root.getAttribute("data-scheme") === "dark" ? "light" : "dark";
    setTheme(next, btn);
  });
});

document.querySelectorAll('input[name="pry-theme"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) setTheme(radio.value, radio.closest("label") ?? radio);
  });
});

window.addEventListener("storage", (e) => {
  if (e.key === "pry-theme") syncControls();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncControls);

syncControls();
