// "What should Pawtrol call you?" field on the settings page. Saved on its own
// key so the bundled options.js never overwrites it.

const PROFILE_KEY = "pry-profile";
const input = document.getElementById("pry-name");

let timer = 0;

async function save() {
  try {
    const current = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY] ?? {};
    await chrome.storage.local.set({
      [PROFILE_KEY]: { ...current, name: input.value.trim().slice(0, 32) },
    });
  } catch {
    /* storage unavailable; nothing to do */
  }
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(save, 400);
});
document.getElementById("save")?.addEventListener("click", save);

(async () => {
  try {
    const profile = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
    input.value = profile?.name ?? "";
  } catch {
    /* ignore */
  }
})();
