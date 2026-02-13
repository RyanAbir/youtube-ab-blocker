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
let forcedFastForward = false;
let adStartTime = 0;
let lastVideoTime = 0;
let lastVideoProgress = 0;

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

const SKIP_SELECTORS = [
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button-icon",
  ".ytp-ad-player-overlay-skip-button",
];
const OVERLAY_SELECTORS = [
  ".ytp-ad-overlay-close-button",
  ".ytp-ad-image-overlay-close-button",
  ".ytp-ad-overlay-close-button-icon",
];
const ENFORCEMENT_SELECTORS = [
  "ytd-enforcement-message-view-model",
  "ytd-enforcement-message-renderer",
  "ytd-popup-container tp-yt-paper-dialog",
  "tp-yt-iron-overlay-backdrop",
];
const CLICK_DEBOUNCE = 400;
const STUCK_AD_MS = 2000;
let lastSkipClick = 0;
let lastOverlayClick = 0;
let observedSkip = false;

function forceClick(el) {
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const type of events) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      })
    );
  }
}

function findVisibleElement(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    return el;
  }
  return null;
}

function handleSkipButton() {
  if (!blockingEnabled) return;
  const now = Date.now();
  if (now - lastSkipClick < CLICK_DEBOUNCE) return;

  const btn = findVisibleElement(SKIP_SELECTORS);
  if (!btn) return;

  forceClick(btn);
  lastSkipClick = now;
  skipped++;
  render();
}

function handleOverlayClose() {
  if (!blockingEnabled) return;
  const now = Date.now();
  if (now - lastOverlayClick < CLICK_DEBOUNCE) return;

  const btn = findVisibleElement(OVERLAY_SELECTORS);
  if (!btn) return;

  btn.click();
  lastOverlayClick = now;
  closed++;
  render();
}

function handleVideoAds() {
  if (!blockingEnabled) return;

  const player = document.querySelector("video.html5-main-video");
  const playerRoot = document.querySelector(".html5-video-player");
  if (!player || !playerRoot) return;

  const now = Date.now();
  const adShowing = playerRoot.classList.contains("ad-showing");
  if (!adShowing) {
    if (forcedFastForward) {
      player.playbackRate = 1;
      player.muted = false;
      forcedFastForward = false;
    }
    adStartTime = 0;
    return;
  }

  if (!adStartTime) {
    adStartTime = now;
    lastVideoTime = player.currentTime;
    lastVideoProgress = now;
  }

  if (Math.abs(player.currentTime - lastVideoTime) > 0.05) {
    lastVideoTime = player.currentTime;
    lastVideoProgress = now;
  }

  const adUiPresent = !!playerRoot.querySelector(
    ".ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-container, .ytp-ad-persistent-progress-bar-container"
  );
  const isStuckAd =
    now - adStartTime > STUCK_AD_MS &&
    now - lastVideoProgress > STUCK_AD_MS &&
    !adUiPresent &&
    player.readyState < 2;

  if (isStuckAd) {
    playerRoot.classList.remove("ad-showing", "ad-interrupting");
    player.playbackRate = 1;
    player.muted = false;
    forcedFastForward = false;
    adStartTime = 0;
    player.play().catch(() => {});
    return;
  }

  // Attempt to jump to the end of the ad immediately
  if (isFinite(player.duration) && player.duration > 0) {
    const epsilon = 0.05;
    if (player.currentTime < player.duration - epsilon) {
      player.currentTime = player.duration;
      skipped++;
      render();
    }
    return;
  }

  // Fall back to fast-forwarding unskippable ads
  player.playbackRate = 16;
  player.muted = true;
  forcedFastForward = true;
}

// React immediately when YouTube injects the skip button.
function setupSkipObserver() {
  if (observedSkip) return;
  const playerRoot = document.querySelector(".html5-video-player");
  if (!playerRoot) return;

  const observer = new MutationObserver(() => {
    const btn = findVisibleElement(SKIP_SELECTORS);
    if (btn) {
      forceClick(btn);
      skipped++;
      render();

      const video = document.querySelector("video.html5-main-video");
      if (video && isFinite(video.duration) && video.duration > 0) {
        const epsilon = 0.05;
        if (video.currentTime < video.duration - epsilon) {
          video.currentTime = video.duration;
        }
      }
    }
  });

  observer.observe(playerRoot, { childList: true, subtree: true });
  observedSkip = true;
}

// Remove YouTube's anti-adblock enforcement dialog and keep playback running.
function squashEnforcement() {
  if (!blockingEnabled) return;

  let removed = false;
  for (const selector of ENFORCEMENT_SELECTORS) {
    document.querySelectorAll(selector).forEach((el) => {
      const text = (el.textContent || "").toLowerCase();
      if (text.includes("ad blockers violate") || text.includes("ad blocker")) {
        el.remove();
        removed = true;
      }
    });
  }

  if (removed) {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";

    const playerRoot = document.querySelector(".html5-video-player");
    if (playerRoot) {
      playerRoot.classList.remove("ad-interrupting");
    }
    const video = document.querySelector("video.html5-main-video");
    if (video && video.paused) {
      video.play().catch(() => {});
    }
  }
}

setInterval(() => {
  handleSkipButton();
  handleOverlayClose();
}, 200);

setInterval(handleVideoAds, 400);
setInterval(squashEnforcement, 800);
setInterval(setupSkipObserver, 500);

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
