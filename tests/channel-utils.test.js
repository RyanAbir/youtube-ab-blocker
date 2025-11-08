import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChannelName,
  extractChannelHandle,
  isWhitelistedChannel,
} from "../lib/channel-utils.js";

test("normalizeChannelName trims, strips @, and lowercases", () => {
  assert.equal(normalizeChannelName("  @LinusTechTips  "), "linustechtips");
  assert.equal(normalizeChannelName("@@MrBeast"), "mrbeast");
});

test("normalizeChannelName returns null for invalid values", () => {
  assert.equal(normalizeChannelName("   "), null);
  assert.equal(normalizeChannelName(null), null);
});

test("extractChannelHandle pulls handle from full YouTube URL", () => {
  const url = "https://www.youtube.com/@SomeCreator/videos";
  assert.equal(extractChannelHandle(url), "somecreator");
});

test("extractChannelHandle returns null for non-handle URLs", () => {
  const url = "https://www.youtube.com/watch?v=12345";
  assert.equal(extractChannelHandle(url), null);
});

test("isWhitelistedChannel matches list entries case-insensitively", () => {
  const whitelist = ["LinusTechTips", "mrbeast"];
  assert.ok(isWhitelistedChannel("https://youtube.com/@linustechtips", whitelist));
  assert.ok(isWhitelistedChannel("@MrBeast", whitelist));
});

test("isWhitelistedChannel returns false when not present", () => {
  const whitelist = ["somebody"];
  assert.equal(isWhitelistedChannel("https://youtube.com/@Other", whitelist), false);
});
