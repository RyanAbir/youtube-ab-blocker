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
let lastPlaybackTime = 0;
let lastPlaybackProgress = 0;
let bridgeInjected = false;
let trackedVideo = null;
let lastFrameTime = 0;
let lastTempDisable = 0;
let userPaused = false;

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
const STUCK_PLAYBACK_MS = 3500;
const TEMP_DISABLE_COOLDOWN_MS = 60000;
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

function isVisibleElement(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

function findVisibleElement(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (!isVisibleElement(el)) continue;
    return el;
  }
  return null;
}

function injectPlayerBridge() {
  if (bridgeInjected) return;
  const script = document.createElement("script");
  script.textContent = `
    (() => {
      if (window.__ytAdBlockerBridge) return;
      window.__ytAdBlockerBridge = true;
      window.addEventListener("ytAdBlocker:command", (e) => {
        const cmd = e.detail;
        const player = document.getElementById("movie_player");
        if (!player) return;
        try {
          if (cmd === "skipAd" && typeof player.skipAd === "function") player.skipAd();
          if (cmd === "cancelAd" && typeof player.cancelAd === "function") player.cancelAd();
          if (cmd === "play" && typeof player.playVideo === "function") player.playVideo();
          if (cmd === "stop" && typeof player.stopVideo === "function") player.stopVideo();
          if (cmd === "seekStart" && typeof player.seekTo === "function") player.seekTo(0, true);
        } catch (_) {}
      });
    })();
  `;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
  bridgeInjected = true;
}

function sendPlayerCommand(cmd) {
  injectPlayerBridge();
  window.dispatchEvent(new CustomEvent("ytAdBlocker:command", { detail: cmd }));
}

function ensureFrameCallback(video) {
  if (!video || typeof video.requestVideoFrameCallback !== "function") return;
  if (trackedVideo === video) return;
  trackedVideo = video;
  const tick = () => {
    lastFrameTime = Date.now();
    if (trackedVideo === video) {
      video.requestVideoFrameCallback(tick);
    }
  };
  video.requestVideoFrameCallback(tick);
}

function tempDisableBlocking() {
  const now = Date.now();
  if (now - lastTempDisable < TEMP_DISABLE_COOLDOWN_MS) return;
  lastTempDisable = now;
  chrome.runtime.sendMessage({ action: "tempDisableBlocking", durationMs: 15000 });
}

function handleSkipButton() {
  if (!blockingEnabled) return;
  const playerRoot = document.querySelector(".html5-video-player");
  if (!playerRoot || !playerRoot.classList.contains("ad-showing")) return;
  const now = Date.now();
  if (now - lastSkipClick < CLICK_DEBOUNCE) return;

  const btn = findVisibleElement(SKIP_SELECTORS);
  if (!btn) return;

  forceClick(btn);
  lastSkipClick = now;
  skipped++;
  sendPlayerCommand("skipAd");
  render();
}

function handleOverlayClose() {
  if (!blockingEnabled) return;
  const playerRoot = document.querySelector(".html5-video-player");
  if (!playerRoot || !playerRoot.classList.contains("ad-showing")) return;
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
  ensureFrameCallback(player);

  const now = Date.now();
  if (!lastPlaybackProgress) {
    lastPlaybackTime = player.currentTime;
    lastPlaybackProgress = now;
  }

  if (Math.abs(player.currentTime - lastPlaybackTime) > 0.05) {
    lastPlaybackTime = player.currentTime;
    lastPlaybackProgress = now;
  }

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

  const adUiPresent = !!findVisibleElement([
    ".ytp-ad-player-overlay",
    ".ytp-ad-text",
    ".ytp-ad-preview-container",
    ".ytp-ad-persistent-progress-bar-container",
    ".ytp-ad-simple-ad-badge",
    ".ytp-ad-duration-remaining",
    ".ytp-ad-timer",
  ]);
  const isStuckAd =
    now - adStartTime > STUCK_AD_MS &&
    now - lastVideoProgress > STUCK_AD_MS &&
    !adUiPresent;

  if (isStuckAd) {
    playerRoot.classList.remove("ad-showing", "ad-interrupting");
    player.playbackRate = 1;
    player.muted = false;
    forcedFastForward = false;
    adStartTime = 0;
    player.play().catch(() => {});
    sendPlayerCommand("cancelAd");
    sendPlayerCommand("skipAd");
    sendPlayerCommand("play");
    tempDisableBlocking();
    return;
  }

  // If YouTube claims an ad is showing but we don't see ad UI, avoid forcing
  // jumps/fast-forwarding that can stall the main video.
  if (!adUiPresent) {
    if (player.paused) {
      player.play().catch(() => {});
      sendPlayerCommand("play");
    }
    return;
  }

  // Attempt to jump to the end of the ad immediately
  if (isFinite(player.duration) && player.duration > 0) {
    const epsilon = 0.05;
    if (player.currentTime < player.duration - epsilon && player.duration <= 60) {
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
      sendPlayerCommand("skipAd");
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

// Playback recovery when video stalls without ad UI (black screen guard).
setInterval(() => {
  const player = document.querySelector("video.html5-main-video");
  const playerRoot = document.querySelector(".html5-video-player");
  if (!player || !playerRoot) return;
  ensureFrameCallback(player);
  if (playerRoot.classList.contains("ad-showing")) return;
  if (userPaused) return;

  const now = Date.now();
  const stalledTooLong =
    now - lastPlaybackProgress > STUCK_PLAYBACK_MS &&
    (lastFrameTime === 0 || now - lastFrameTime > STUCK_PLAYBACK_MS) &&
    player.currentTime < 1 &&
    player.readyState < 2;

  if (stalledTooLong) {
    playerRoot.classList.remove("ad-showing", "ad-interrupting");
    player.playbackRate = 1;
    player.muted = false;
    player.play().catch(() => {});
    sendPlayerCommand("play");
    sendPlayerCommand("seekStart");
    tempDisableBlocking();
  }
}, 700);

// Respect user-initiated pause.
document.addEventListener(
  "pause",
  (e) => {
    const player = e.target;
    if (!(player instanceof HTMLVideoElement)) return;
    const playerRoot = document.querySelector(".html5-video-player");
    if (playerRoot?.classList.contains("ad-showing")) return;
    if (player.readyState >= 2) {
      userPaused = true;
    }
  },
  true
);

document.addEventListener(
  "play",
  (e) => {
    const player = e.target;
    if (!(player instanceof HTMLVideoElement)) return;
    userPaused = false;
  },
  true
);

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
