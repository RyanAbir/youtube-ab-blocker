export function normalizeChannelName(value) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.trim().replace(/^@+/, "").toLowerCase();
  return normalized || null;
}

export function extractChannelHandle(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/youtube\.com\/@([^\/?#]+)/i);
  if (!match) return null;
  return normalizeChannelName(match[1]);
}

function resolveHandle(input) {
  if (typeof input !== "string") return null;
  if (input.includes("youtube.com/")) {
    return extractChannelHandle(input);
  }
  return normalizeChannelName(input);
}

export function isWhitelistedChannel(channelOrUrl, whitelist = []) {
  if (!Array.isArray(whitelist) || !whitelist.length) return false;
  const handle = resolveHandle(channelOrUrl);
  if (!handle) return false;
  return whitelist.some((entry) => normalizeChannelName(entry) === handle);
}
