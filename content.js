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
let lastPlayerSkip = 0;

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
  "button.ytp-ad-skip-button-modern",
  "button.ytp-ad-skip-button",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button-icon",
  ".ytp-ad-player-overlay-skip-button",
  ".ytp-ad-skip-button-slot",
];
const OVERLAY_SELECTORS = [
  "button.ytp-ad-overlay-close-button",
  ".ytp-ad-overlay-close-button",
  ".ytp-ad-image-overlay-close-button",
  ".ytp-ad-overlay-close-button-icon",
];
const AD_UI_SELECTORS = [
  ".ytp-ad-player-overlay",
  ".ytp-ad-text",
  ".ytp-ad-preview-container",
  ".ytp-ad-persistent-progress-bar-container",
  ".ytp-ad-simple-ad-badge",
  ".ytp-ad-duration-remaining",
  ".ytp-ad-timer",
  ".ytp-ad-badge",
  ".ytp-ad-badge--engagement",
  ".ytp-ad-message-container",
  ".ytp-ad-skip-button-container",
];
const ENFORCEMENT_SELECTORS = [
  "ytd-enforcement-message-view-model",
  "ytd-enforcement-message-renderer",
  "ytd-popup-container tp-yt-paper-dialog",
  "tp-yt-iron-overlay-backdrop",
];
const CLICK_DEBOUNCE = 400;
const STUCK_AD_MS = 1200;
const STUCK_PLAYBACK_MS = 3500;
const TEMP_DISABLE_COOLDOWN_MS = 60000;
const PLAYER_SKIP_DEBOUNCE = 250;
const MAX_AD_JUMP_SECONDS = 180;
const OBSERVER_DEBOUNCE = 120;
const RECOVERY_DISABLE_MS = 2500;
let lastSkipClick = 0;
let lastOverlayClick = 0;
let observedSkip = false;
let lastObserverRun = 0;
let overlayMounted = false;
let playerObserver = null;

function mountOverlay() {
  if (overlayMounted || !document.body) return;
  document.body.appendChild(box);
  overlayMounted = true;
}

if (document.body) {
  mountOverlay();
} else {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
}

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
  if (style.pointerEvents === "none") return false;
  return true;
}

function findVisibleElement(selectors) {
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const el of nodes) {
      if (!isVisibleElement(el)) continue;
      return el;
    }
  }
  return null;
}

function getPlayerRoot() {
  return document.querySelector(".html5-video-player");
}

function getVideoPlayer() {
  return document.querySelector("video.html5-main-video");
}

function getAdContext() {
  const playerRoot = getPlayerRoot();
  const player = getVideoPlayer();
  const adUiPresent = !!findVisibleElement(AD_UI_SELECTORS);
  return {
    player,
    playerRoot,
    adUiPresent,
    adShowing: isAdShowing(playerRoot, adUiPresent),
  };
}

function resolveClickable(el) {
  if (!el) return null;
  if (el.matches("button,[role='button']")) return el;
  const btn = el.querySelector("button,[role='button']");
  if (btn && isVisibleElement(btn)) return btn;
  return el;
}

function isAdShowing(playerRoot, adUiPresent) {
  if (playerRoot?.classList.contains("ad-showing")) return true;
  if (playerRoot?.classList.contains("ad-interrupting")) return true;
  const moviePlayer = document.getElementById("movie_player");
  if (moviePlayer?.classList.contains("ad-showing")) return true;
  if (moviePlayer?.classList.contains("ad-interrupting")) return true;
  const ytdPlayer = document.querySelector("ytd-player");
  if (ytdPlayer?.classList.contains("ad-showing")) return true;
  if (ytdPlayer?.classList.contains("ad-interrupting")) return true;
  return !!adUiPresent;
}

function sendSkipCommands(now = Date.now()) {
  if (now - lastPlayerSkip <= PLAYER_SKIP_DEBOUNCE) return false;
  sendPlayerCommand("skipAd");
  sendPlayerCommand("cancelAd");
  lastPlayerSkip = now;
  return true;
}

function jumpAdToEnd(player, playerRoot) {
  if (
    !player ||
    !isFinite(player.duration) ||
    player.duration <= 0 ||
    player.duration > MAX_AD_JUMP_SECONDS
  ) {
    return false;
  }

  const epsilon = 0.05;
  if (player.currentTime < player.duration - epsilon) {
    player.currentTime = player.duration;
    skipped++;
    render();
  } else {
    recoverPlayback(player, playerRoot);
  }
  return true;
}

function clickDismissTarget(selectors, lastClickAt, onSuccess) {
  const now = Date.now();
  if (now - lastClickAt < CLICK_DEBOUNCE) return lastClickAt;

  const target = resolveClickable(findVisibleElement(selectors));
  if (!target) return lastClickAt;

  forceClick(target);
  if (typeof target.click === "function") {
    target.click();
  }
  onSuccess();
  return now;
}

function attemptAdDismiss() {
  if (!blockingEnabled) return;
  const { player, playerRoot, adUiPresent } = getAdContext();
  if (!adUiPresent) return;

  sendSkipCommands();
  jumpAdToEnd(player, playerRoot);

  lastSkipClick = clickDismissTarget(SKIP_SELECTORS, lastSkipClick, () => {
    skipped++;
    render();
  });

  lastOverlayClick = clickDismissTarget(OVERLAY_SELECTORS, lastOverlayClick, () => {
    closed++;
    render();
  });
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

injectPlayerBridge();

function recoverPlayback(player, playerRoot, { tempDisable = false } = {}) {
  playerRoot?.classList.remove("ad-showing", "ad-interrupting", "ad-created");
  const moviePlayer = document.getElementById("movie_player");
  moviePlayer?.classList.remove("ad-showing", "ad-interrupting", "ad-created");

  if (player) {
    player.playbackRate = 1;
    player.muted = false;
    player.play().catch(() => {});
  }

  forcedFastForward = false;
  adStartTime = 0;
  sendPlayerCommand("cancelAd");
  sendPlayerCommand("skipAd");
  sendPlayerCommand("play");

  if (tempDisable) {
    chrome.runtime.sendMessage({
      action: "tempDisableBlocking",
      durationMs: RECOVERY_DISABLE_MS,
    });
  }
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
  chrome.runtime.sendMessage({ action: "tempDisableBlocking", durationMs: RECOVERY_DISABLE_MS });
}

function handleSkipButton() {
  if (!blockingEnabled) return;
  const { adShowing } = getAdContext();
  if (!adShowing) return;

  lastSkipClick = clickDismissTarget(SKIP_SELECTORS, lastSkipClick, () => {
    skipped++;
    sendPlayerCommand("skipAd");
    render();
  });
}

function handleOverlayClose() {
  if (!blockingEnabled) return;
  const { adShowing } = getAdContext();
  if (!adShowing) return;

  lastOverlayClick = clickDismissTarget(OVERLAY_SELECTORS, lastOverlayClick, () => {
    closed++;
    render();
  });
}

function handleVideoAds() {
  if (!blockingEnabled) return;

  const { player, playerRoot, adUiPresent, adShowing } = getAdContext();
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

  sendSkipCommands(now);

  const isStuckAd =
    now - adStartTime > STUCK_AD_MS &&
    now - lastVideoProgress > STUCK_AD_MS &&
    !adUiPresent;

  if (isStuckAd) {
    recoverPlayback(player, playerRoot);
    tempDisableBlocking();
    return;
  }

  if (jumpAdToEnd(player, playerRoot)) {
    return;
  }

  // If YouTube claims an ad is showing but we don't see ad UI, force fast
  // progress rather than waiting for the overlay to appear.
  if (!adUiPresent) {
    if (player.paused) {
      player.play().catch(() => {});
      sendPlayerCommand("play");
    }
    player.playbackRate = 16;
    player.muted = true;
    forcedFastForward = true;
    if (now - adStartTime > STUCK_AD_MS) {
      recoverPlayback(player, playerRoot);
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
  if (observedSkip && playerObserver) return;
  const playerRoot = document.querySelector(".html5-video-player");
  if (!playerRoot) return;

  playerObserver?.disconnect();

  playerObserver = new MutationObserver(() => {
    handleVideoAds();
    attemptAdDismiss();

    const btn = findVisibleElement(SKIP_SELECTORS);
    if (btn) {
      forceClick(btn);
      skipped++;
      sendPlayerCommand("skipAd");
      render();

      const video = getVideoPlayer();
      if (video && isFinite(video.duration) && video.duration > 0) {
        const epsilon = 0.05;
        if (video.currentTime < video.duration - epsilon) {
          video.currentTime = video.duration;
        }
      }
    }
  });

  playerObserver.observe(playerRoot, { childList: true, subtree: true });
  playerObserver.observe(playerRoot, { attributes: true, attributeFilter: ["class"] });
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
}, 100);

setInterval(handleVideoAds, 150);
setInterval(squashEnforcement, 800);
setInterval(setupSkipObserver, 250);
setInterval(attemptAdDismiss, 75);

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
    recoverPlayback(player, playerRoot, { tempDisable: true });
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

// Aggressive observer for late-loading ad UI.
const adObserver = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastObserverRun < OBSERVER_DEBOUNCE) return;
  lastObserverRun = now;
  attemptAdDismiss();
});
if (document.body) {
  adObserver.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (document.body) {
        adObserver.observe(document.body, { childList: true, subtree: true });
      }
    },
    { once: true }
  );
}

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
