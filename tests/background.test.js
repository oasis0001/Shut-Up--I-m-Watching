import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";

const BACKGROUND_SCRIPT = fs.readFileSync(
  path.resolve(process.cwd(), "background.js"),
  "utf8"
);

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=test-video";
const SPOTIFY_URL = "https://open.spotify.com/";
const DUCKED_VOLUME = 0.3;

class FakeChromeEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  dispatch(...args) {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}

class FakeChrome {
  constructor(initialTabs = []) {
    this._tabs = new Map();
    this._youtubeStates = new Map();
    this._youtubeConnectedTabs = new Set();
    this._spotifyConnectedTabs = new Set();
    this._spotifyResponders = new Map();

    this.spotifyCommands = [];

    this.runtime = {
      onMessage: new FakeChromeEvent(),
      onInstalled: new FakeChromeEvent(),
      onStartup: new FakeChromeEvent(),
      lastError: null,
    };

    this.windows = {
      onFocusChanged: new FakeChromeEvent(),
    };

    this.tabs = {
      query: async (queryInfo) => this._queryTabs(queryInfo),
      sendMessage: async (tabId, payload) => this._sendMessage(tabId, payload),
      onActivated: new FakeChromeEvent(),
      onUpdated: new FakeChromeEvent(),
      onRemoved: new FakeChromeEvent(),
    };

    this.scripting = {
      executeScript: async ({ target, files }) =>
        this._executeScript(target?.tabId, files?.[0]),
    };

    for (const tab of initialTabs) {
      this.addTab(tab);
    }
  }

  addTab(tab) {
    const normalizedTab = {
      id: tab.id,
      url: tab.url,
      active: Boolean(tab.active),
      lastFocusedWindow: tab.lastFocusedWindow ?? true,
    };

    this._tabs.set(normalizedTab.id, normalizedTab);

    if (tab.youtubeConnected) {
      this._youtubeConnectedTabs.add(normalizedTab.id);
    }

    if (tab.spotifyConnected) {
      this._spotifyConnectedTabs.add(normalizedTab.id);
    }
  }

  removeTab(tabId) {
    this._tabs.delete(tabId);
    this._youtubeConnectedTabs.delete(tabId);
    this._spotifyConnectedTabs.delete(tabId);
    this._youtubeStates.delete(tabId);
    this._spotifyResponders.delete(tabId);
    this.tabs.onRemoved.dispatch(tabId);
  }

  setActiveTab(tabId) {
    for (const tab of this._tabs.values()) {
      tab.active = tab.id === tabId;
    }
    this.tabs.onActivated.dispatch({ tabId });
  }

  setYouTubeState(tabId, state) {
    this._youtubeStates.set(tabId, {
      isPlaying: Boolean(state.isPlaying),
      onVideoPage: Boolean(state.onVideoPage),
      url: typeof state.url === "string" ? state.url : "",
    });
  }

  dispatchYouTubePlaybackState(tabId, state) {
    const tab = this._tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }

    this.setYouTubeState(tabId, state);
    this.runtime.onMessage.dispatch(
      {
        type: "YOUTUBE_PLAYBACK_STATE",
        isPlaying: Boolean(state.isPlaying),
        onVideoPage: Boolean(state.onVideoPage),
        url: state.url ?? tab.url,
      },
      { tab: { id: tabId, url: tab.url } },
      () => {}
    );
  }

  setSpotifyResponder(tabId, responder) {
    this._spotifyResponders.set(tabId, responder);
  }

  updateTab(tabId, changeInfo) {
    const tab = this._tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }

    if (typeof changeInfo.url === "string") {
      tab.url = changeInfo.url;
    }

    this.tabs.onUpdated.dispatch(tabId, changeInfo, { ...tab });
  }

  _executeScript(tabId, scriptFile) {
    const tab = this._tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }

    if (scriptFile === "youtube_content.js" && isYouTubeUrl(tab.url)) {
      this._youtubeConnectedTabs.add(tabId);
      return;
    }

    if (scriptFile === "spotify_content.js" && isSpotifyUrl(tab.url)) {
      this._spotifyConnectedTabs.add(tabId);
      return;
    }

    throw new Error("Cannot access contents of this tab");
  }

  _queryTabs(queryInfo) {
    let tabs = Array.from(this._tabs.values());

    if (queryInfo?.active) {
      tabs = tabs.filter((tab) => tab.active);
    }

    if (Array.isArray(queryInfo?.url)) {
      tabs = tabs.filter((tab) =>
        queryInfo.url.some((pattern) => urlMatchesPattern(tab.url, pattern))
      );
    }

    return tabs.map((tab) => ({ ...tab }));
  }

  _sendMessage(tabId, payload) {
    const tab = this._tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }

    if (payload?.type === "GET_YOUTUBE_STATE") {
      if (!this._youtubeConnectedTabs.has(tabId)) {
        throw missingReceiverError();
      }

      return (
        this._youtubeStates.get(tabId) ?? {
          isPlaying: false,
          onVideoPage: false,
          url: tab.url,
        }
      );
    }

    if (payload?.type === "SET_SPOTIFY_VOLUME") {
      if (!this._spotifyConnectedTabs.has(tabId)) {
        throw missingReceiverError();
      }

      const responder = this._spotifyResponders.get(tabId);
      let success = true;
      if (typeof responder === "function") {
        success = Boolean(responder(payload.volume));
      } else if (typeof responder === "boolean") {
        success = responder;
      }

      this.spotifyCommands.push({
        tabId,
        volume: payload.volume,
        success,
      });

      return { success };
    }

    return {};
  }
}

function missingReceiverError() {
  return new Error("Could not establish connection. Receiving end does not exist.");
}

function parseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch (_error) {
    return null;
  }
}

function isYouTubeUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) {
    return false;
  }
  return (
    parsed.hostname === "youtube.com" ||
    parsed.hostname === "www.youtube.com" ||
    parsed.hostname === "m.youtube.com"
  );
}

function isSpotifyUrl(urlString) {
  const parsed = parseUrl(urlString);
  return Boolean(parsed && parsed.hostname === "open.spotify.com");
}

function urlMatchesPattern(urlString, pattern) {
  const parsed = parseUrl(urlString);
  if (!parsed) {
    return false;
  }

  const hostMatch = pattern.match(/\*:\/\/([^/]+)\//);
  if (!hostMatch) {
    return false;
  }

  return parsed.hostname === hostMatch[1];
}

function loadBackgroundScript(fakeChrome) {
  const context = {
    chrome: fakeChrome,
    console,
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(BACKGROUND_SCRIPT, context, { filename: "background.js" });
}

async function waitFor(predicate, timeoutMs = 2500, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return i;
    }
  }
  return -1;
}

test("lowers Spotify when active YouTube video plays and restores on pause", async () => {
  const chrome = new FakeChrome([
    { id: 1, url: SPOTIFY_URL, active: false, spotifyConnected: true },
    { id: 2, url: YOUTUBE_WATCH_URL, active: true, youtubeConnected: true },
  ]);

  chrome.setYouTubeState(2, {
    isPlaying: false,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  loadBackgroundScript(chrome);

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  const lowered = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command) => command.volume === DUCKED_VOLUME && command.success
    )
  );
  assert.equal(
    lowered,
    true,
    `expected Spotify volume to be lowered to ${DUCKED_VOLUME}`
  );

  const loweredIndex = findLastIndex(
    chrome.spotifyCommands,
    (command) => command.volume === DUCKED_VOLUME && command.success
  );

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: false,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  const restored = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command, index) =>
        index > loweredIndex && command.volume === 1 && command.success
    )
  );
  assert.equal(restored, true, "expected Spotify volume to restore to 1.0");
});

test("does not lower Spotify when YouTube is playing in a background tab", async () => {
  const chrome = new FakeChrome([
    { id: 1, url: SPOTIFY_URL, active: false, spotifyConnected: true },
    { id: 2, url: YOUTUBE_WATCH_URL, active: false, youtubeConnected: true },
    { id: 3, url: "https://example.com/", active: true },
  ]);

  chrome.setYouTubeState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  loadBackgroundScript(chrome);

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  await sleep(600);

  const loweredCommands = chrome.spotifyCommands.filter(
    (command) => command.volume === DUCKED_VOLUME && command.success
  );
  assert.equal(loweredCommands.length, 0);
});

test("retries Spotify volume update after transient failures", async () => {
  const chrome = new FakeChrome([
    { id: 1, url: SPOTIFY_URL, active: false, spotifyConnected: true },
    { id: 2, url: YOUTUBE_WATCH_URL, active: true, youtubeConnected: true },
  ]);

  let acceptsCommands = false;
  chrome.setSpotifyResponder(1, () => acceptsCommands);
  chrome.setYouTubeState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  loadBackgroundScript(chrome);

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  const firstFailure = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command) => command.volume === DUCKED_VOLUME && !command.success
    )
  );
  assert.equal(firstFailure, true, "expected at least one failed lowering attempt");

  acceptsCommands = true;

  const eventuallySucceeded = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command) => command.volume === DUCKED_VOLUME && command.success
    ),
    3500
  );
  assert.equal(
    eventuallySucceeded,
    true,
    "expected retry to eventually lower volume successfully"
  );
});

test("restores volume when the active YouTube tab closes", async () => {
  const chrome = new FakeChrome([
    { id: 1, url: SPOTIFY_URL, active: false, spotifyConnected: true },
    { id: 2, url: YOUTUBE_WATCH_URL, active: true, youtubeConnected: true },
  ]);

  chrome.setYouTubeState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  loadBackgroundScript(chrome);

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  const lowered = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command) => command.volume === DUCKED_VOLUME && command.success
    )
  );
  assert.equal(lowered, true, "expected lowered state before closing tab");

  const loweredIndex = findLastIndex(
    chrome.spotifyCommands,
    (command) => command.volume === DUCKED_VOLUME && command.success
  );

  chrome.removeTab(2);

  const restored = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command, index) =>
        index > loweredIndex && command.volume === 1 && command.success
    )
  );
  assert.equal(restored, true, "expected restore after tab closure");
});

test("applies desired lowered volume when Spotify tab opens after ducking started", async () => {
  const chrome = new FakeChrome([
    { id: 2, url: YOUTUBE_WATCH_URL, active: true, youtubeConnected: true },
  ]);

  chrome.setYouTubeState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  loadBackgroundScript(chrome);

  chrome.dispatchYouTubePlaybackState(2, {
    isPlaying: true,
    onVideoPage: true,
    url: YOUTUBE_WATCH_URL,
  });

  await sleep(500);
  assert.equal(chrome.spotifyCommands.length, 0);

  chrome.addTab({ id: 3, url: SPOTIFY_URL, active: false, spotifyConnected: false });
  chrome.updateTab(3, { url: SPOTIFY_URL, status: "loading" });
  chrome.updateTab(3, { status: "complete" });

  const lowered = await waitFor(() =>
    chrome.spotifyCommands.some(
      (command) =>
        command.tabId === 3 &&
        command.volume === DUCKED_VOLUME &&
        command.success
    )
  );
  assert.equal(lowered, true, "expected new Spotify tab to receive desired volume");
});
