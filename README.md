# YouTube Ad Blocker

Chrome extension that blocks YouTube ads with dynamic rules, auto-skips in-player adverts, and gives you a live overlay showing how many ads were blocked, skipped, or closed. You can toggle protection or whitelist specific channels from the Options page.

## Features
- **Dynamic network blocking** via Declarative Net Request (DNR) rules for the common ad hosts and endpoints YouTube uses.
- **Auto-skip overlay** injected into every YouTube tab that clicks the “Skip” and overlay-close buttons as soon as they appear and shows live stats.
- **Channel whitelist & toggle** managed through the Options page and stored in `chrome.storage`.
- **Rule-state awareness** so disabling or whitelisting actually unloads the DNR rules until you re-enable blocking.
- **Unit-tested channel utilities** (Node’s built-in test runner) to ensure handle detection stays accurate.

## Project Structure
```
.
├── background.js          # MV3 service worker (rule loading, whitelist, messaging)
├── content.js             # Live overlay + ad-skip actions inside each tab
├── manifest.json          # Chrome extension manifest
├── options.html/js        # Settings UI for toggle + whitelist
├── rules/ruleset_1.json   # Baseline DNR blocking rules
├── lib/channel-utils.js   # Shared helpers for normalizing/whitelisting channels
├── tests/                 # Node unit tests (node --test)
└── package.json           # Declares ES module + test script
```

## Prerequisites
- Google Chrome (or Chromium-based browser) that supports Manifest V3.
- [Node.js 20+](https://nodejs.org/) – required only if you want to run the tests (`npm` is included with Node).

## Getting Started
1. **Clone/download** this repository.
2. **Install Node dependencies** (there are currently none, but this populates `package-lock.json` if needed later):
   ```bash
   npm install
   ```
3. **Load the extension in Chrome**:
   - Open `chrome://extensions`.
   - Toggle **Developer mode** on (top right).
   - Click **Load unpacked** and select the `youtube-ad-blocker` folder.
   - The extension icon should now appear in your toolbar.

## Using the Extension
- Visit YouTube: the overlay appears in the bottom-right with live statistics.
- Open **Extension options** (right-click the icon → Options) to:
  - Toggle ad blocking on/off.
  - Add/remove channel handles (with or without `@`). When a tab’s channel is on the whitelist, DNR rules unload automatically until you leave the channel.
- If you change the ruleset, background logic, or content script, click **Reload** on the extension card in `chrome://extensions`.

## Tests & Development
- Run the Node test suite (channel utils):
  ```bash
  npm test
  ```
- All source files are plain JavaScript/CSS/HTML, so no build tooling is required.
- The repository is initialized with Git; make sure to reload after changes so MV3 picks up the latest files.

## Troubleshooting
- **Receiving end does not exist** warnings are handled internally; they surface only if a message truly can’t be delivered.
- If the overlay shows “Blocking is disabled,” confirm the toggle in the Options page and reload the tab.
- After editing DNR rules, you must reload the extension to re-register rules.

## Contributing / Tracking Changes
- Commit work on feature branches and open pull requests.
- Keep tests passing (`npm test`) before pushing.
- Document user-facing changes (UI, behavior, new options) in this README to keep instructions current.

Enjoy an ad-free YouTube experience!
