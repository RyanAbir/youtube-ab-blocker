import { extractChannelHandle, isWhitelistedChannel } from "./lib/channel-utils.js";

// === Safe boot sequence ===
console.log("YouTube Ad Blocker service-worker starting...");

let currentWhitelist = [];
let blockedCount = 0;
let blockingEnabled = true;
let userDisabled = false;
let tempDisableUntil = 0;
let tempDisableTimer = null;

function loadStoredState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["whitelist", "blockingEnabled"], (data) => {
      currentWhitelist = data.whitelist || [];
      blockingEnabled = data.blockingEnabled ?? true;
      resolve();
    });
  });
}

async function clearDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map((r) => r.id);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    console.log("Old rules cleared:", ids);
  }
}

// --- helper: reload all rules safely ---
async function reloadRules() {
  if (tempDisableUntil > Date.now()) {
    console.log("Temporary disable active, skipping rule load.");
    return;
  }

  if (!blockingEnabled) {
    console.log("Blocking disabled, skipping rule load.");
    return;
  }

  try {
    await clearDynamicRules();

    const res = await fetch(chrome.runtime.getURL("rules/ruleset_1.json"));
    const rules = await res.json();
    const unique = rules.map((r, i) => ({ ...r, id: i + 1 }));
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: unique });
    console.log("Rules loaded:", unique.length);
  } catch (e) {
    console.error("reloadRules failed:", e);
  }
}

async function initializeRules() {
  await loadStoredState();
  userDisabled = blockingEnabled === false;
  if (blockingEnabled) {
    await reloadRules();
  } else {
    await clearDynamicRules();
  }
}

// Init on install/start
chrome.runtime.onInstalled.addListener(initializeRules);
chrome.runtime.onStartup.addListener(initializeRules);

// Debug listener for blocked requests
function safeSend(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    const err = chrome.runtime.lastError;
    if (err && !/Receiving end does not exist/i.test(err.message)) {
      console.warn("tabs.sendMessage failed:", err.message);
    }
  });
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(() => {
    blockedCount++;
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) =>
      tabs.forEach((t) => safeSend(t.id, { action: "updateBlocked", count: blockedCount }))
    );
  });
}

// Message bus
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case "disableBlocking":
        blockingEnabled = false;
        userDisabled = true;
        await clearDynamicRules();
        console.log("Blocking disabled");
        break;

      case "enableBlocking":
        blockingEnabled = true;
        userDisabled = false;
        await reloadRules();
        console.log("Blocking enabled");
        break;

      case "updateWhitelist":
        currentWhitelist = msg.list || [];
        console.log("Whitelist:", currentWhitelist);
        break;

      case "requestStats":
        if (sender.tab?.id) {
          safeSend(sender.tab.id, { action: "updateBlocked", count: blockedCount });
        }
        break;

      case "tempDisableBlocking": {
        if (userDisabled) break;
        const durationMs = Math.max(1000, Number(msg.durationMs) || 15000);
        tempDisableUntil = Date.now() + durationMs;
        blockingEnabled = false;
        await clearDynamicRules();
        if (tempDisableTimer) clearTimeout(tempDisableTimer);
        tempDisableTimer = setTimeout(async () => {
          if (userDisabled) return;
          tempDisableUntil = 0;
          blockingEnabled = true;
          await reloadRules();
        }, durationMs);
        console.log("Blocking temporarily disabled for", durationMs, "ms");
        break;
      }
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// Channel-based whitelist check
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (tempDisableUntil > Date.now() || !blockingEnabled || !info.url || !tab?.url) return;

  const handle = extractChannelHandle(tab.url);
  if (!handle) return;

  if (isWhitelistedChannel(handle, currentWhitelist)) {
    clearDynamicRules().then(() => console.log(`Whitelist pause for ${handle}`));
  } else {
    reloadRules();
  }
});

console.log("Service-worker ready.");
