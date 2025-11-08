// === Safe boot sequence ===
console.log("YouTube Ad Blocker service-worker starting...");

let currentWhitelist = [];
let blockedCount = 0;
let blockingEnabled = true;

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
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(() => {
    blockedCount++;
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) =>
      tabs.forEach((t) =>
        chrome.tabs.sendMessage(t.id, { action: "updateBlocked", count: blockedCount })
      )
    );
  });
}

// Message bus
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case "disableBlocking":
        blockingEnabled = false;
        await clearDynamicRules();
        console.log("Blocking disabled");
        break;

      case "enableBlocking":
        blockingEnabled = true;
        await reloadRules();
        console.log("Blocking enabled");
        break;

      case "updateWhitelist":
        currentWhitelist = msg.list || [];
        console.log("Whitelist:", currentWhitelist);
        break;

      case "requestStats":
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            action: "updateBlocked",
            count: blockedCount,
          });
        }
        break;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// Channel-based whitelist check
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (!blockingEnabled || !info.url || !tab?.url) return;

  if (tab.url.includes("youtube.com/@")) {
    const ch = tab.url.split("youtube.com/@")[1].split("/")[0];
    if (currentWhitelist.includes(ch)) {
      clearDynamicRules().then(() => console.log(`Whitelist pause for ${ch}`));
    } else {
      reloadRules();
    }
  }
});

console.log("Service-worker ready.");
