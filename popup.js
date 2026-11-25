const DEFAULTS = {
  left: 20,
  top: 60,
  width: 360,
  height: 320,
  visible: true,
  moveMode: false,
  fontSize: 14,
  fadeMode: false,
  fadeDelay: 10,
  bold: false,
};
const toggles = ["visible", "moveMode", "fadeMode", "bold"];
const sliders = ["fontSize", "fadeDelay"];

function formatValue(id, value) {
  return id === "fadeDelay" ? value + " s" : String(value);
}

function render(settings) {
  toggles.forEach((id) => (document.getElementById(id).checked = settings[id]));
  sliders.forEach((id) => {
    document.getElementById(id).value = settings[id];
    document.getElementById(id + "Value").textContent = formatValue(id, settings[id]);
  });
}

chrome.storage.local.get(DEFAULTS, render);

toggles.forEach((id) => {
  document.getElementById(id).addEventListener("change", (e) => {
    chrome.storage.local.set({ [id]: e.target.checked });
  });
});

sliders.forEach((id) => {
  document.getElementById(id).addEventListener("input", (e) => {
    const value = Number(e.target.value);
    document.getElementById(id + "Value").textContent = formatValue(id, value);
    chrome.storage.local.set({ [id]: value });
  });
});

document.getElementById("reset").addEventListener("click", () => {
  chrome.storage.local.set(DEFAULTS);
  render(DEFAULTS);
});
