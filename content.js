// === Live overlay ===
const box = document.createElement("div");
Object.assign(box.style, {
  position: "fixed",
  bottom: "10px",
  right: "10px",
  zIndex: 999999,
  background: "rgba(0,0,0,0.75)",
  color: "#0f0",
  padding: "8px 12px",
  fontSize: "12px",
  fontFamily: "monospace",
  borderRadius: "8px",
  boxShadow: "0 0 8px rgba(0,0,0,0.5)",
  pointerEvents: "none",
});
box.textContent = "AdBlock: starting...";
document.body.appendChild(box);

let skipped = 0;
let closed = 0;
let netBlocked = 0;
let blockingEnabled = true;

function render() {
  if (!blockingEnabled) {
    box.style.color = "#f33";
    box.innerHTML = `
      <b>YouTube Ad Blocker</b><br>
      Blocking is currently disabled
    `;
    return;
  }

  box.style.color = "#0f0";
  box.innerHTML = `
    <b>YouTube Ad Blocker</b><br>
    Network Blocked: ${netBlocked}<br>
    Skipped: ${skipped}  Closed: ${closed}
  `;
}

// --- Observe page ---
new MutationObserver(() => {
  const s = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern");
  if (s) {
    s.click();
    skipped++;
    render();
  }

  const o = document.querySelector(".ytp-ad-overlay-close-button");
  if (o) {
    o.click();
    closed++;
    render();
  }
}).observe(document.body, { childList: true, subtree: true });

// --- Listen from background ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "updateBlocked") {
    netBlocked = msg.count;
    render();
  }
});

// --- Reflect toggle state ---
chrome.storage.local.get("blockingEnabled", (d) => {
  blockingEnabled = d.blockingEnabled !== false;
  render();
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.blockingEnabled) {
    blockingEnabled = ch.blockingEnabled.newValue !== false;
    render();
  }
});

// ask for stats on load
chrome.runtime.sendMessage({ action: "requestStats" });
