import { extractChannelHandle, isWhitelistedChannel } from "./lib/channel-utils.js";

// === Safe boot sequence ===
console.log("YouTube Ad Blocker service-worker starting...");

let currentWhitelist = [];
let blockedCount = 0;
let blockingEnabled = true;
let userDisabled = false;
let tempDisableUntil = 0;
let tempDisableTimer = null;
let isWhitelistPaused = false;

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

async function ensureRulesLoaded() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) return;
  await reloadRules();
}

async function getTabById(tabId) {
  if (typeof tabId !== "number") return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function getActiveYouTubeTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: "*://*.youtube.com/*",
  });
  return tabs[0] || null;
}

async function syncRulesForTab(tab) {
  if (tempDisableUntil > Date.now()) return;

  await loadStoredState();

  if (!blockingEnabled) {
    await clearDynamicRules();
    isWhitelistPaused = false;
    return;
  }

  const handle = extractChannelHandle(tab?.url);
  const shouldPause = !!handle && isWhitelistedChannel(handle, currentWhitelist);

  if (shouldPause) {
    await clearDynamicRules();
    isWhitelistPaused = true;
    console.log(`Whitelist pause for ${handle}`);
    return;
  }

  // Reload after leaving a whitelisted channel page or after a worker restart
  // where in-memory state was lost but dynamic rules may be empty.
  if (isWhitelistPaused) {
    isWhitelistPaused = false;
    await reloadRules();
    return;
  }

  await ensureRulesLoaded();
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
  isWhitelistPaused = false;
  if (blockingEnabled) {
    await reloadRules();
  } else {
    await clearDynamicRules();
  }
}

// Init on install/start
chrome.runtime.onInstalled.addListener(initializeRules);
chrome.runtime.onStartup.addListener(initializeRules);
initializeRules();

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
        await syncRulesForTab(sender.tab || (await getActiveYouTubeTab()));
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
          await syncRulesForTab(await getActiveYouTubeTab());
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
  if (info.status !== "complete" && !info.url) return;
  syncRulesForTab(tab || { id, url: info.url }).catch((error) =>
    console.error("syncRulesForTab failed:", error)
  );
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTabById(tabId);
  await syncRulesForTab(tab);
});

console.log("Service-worker ready.");
