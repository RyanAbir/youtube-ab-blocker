document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("blockToggle");
  const statusMsg = document.getElementById("statusMsg");
  const whitelistInput = document.getElementById("whitelistInput");
  const addWhitelistBtn = document.getElementById("addWhitelistBtn");
  const whitelistList = document.getElementById("whitelistList");

  // Load stored settings
  chrome.storage.local.get(["blockingEnabled", "whitelist"], (data) => {
    const enabled = data.blockingEnabled ?? true;
    toggle.checked = enabled;
    statusMsg.textContent = enabled ? "Ad blocking is enabled" : "Ad blocking is disabled";
    renderWhitelist(data.whitelist || []);
  });

  // Toggle enable/disable blocking
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    chrome.storage.local.set({ blockingEnabled: enabled }, () => {
      statusMsg.textContent = enabled ? "Ad blocking is enabled" : "Ad blocking is disabled";
      chrome.runtime.sendMessage({ action: enabled ? "enableBlocking" : "disableBlocking" });
    });
  });

  // Render whitelist
  function renderWhitelist(list) {
    whitelistList.innerHTML = "";
    list.forEach((channel, index) => {
      const li = document.createElement("li");
      li.textContent = channel + " ";
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        list.splice(index, 1);
        chrome.storage.local.set({ whitelist: list });
        renderWhitelist(list);
        chrome.runtime.sendMessage({ action: "updateWhitelist", list });
      });
      li.appendChild(removeBtn);
      whitelistList.appendChild(li);
    });
  }

  // Add new whitelist channel
  addWhitelistBtn.addEventListener("click", () => {
    const channel = whitelistInput.value.trim().replace("@", "");
    if (channel) {
      chrome.storage.local.get("whitelist", (data) => {
        const list = data.whitelist || [];
        if (!list.includes(channel)) {
          list.push(channel);
          chrome.storage.local.set({ whitelist: list });
          renderWhitelist(list);
          chrome.runtime.sendMessage({ action: "updateWhitelist", list });
        }
      });
      whitelistInput.value = "";
    }
  });
});
