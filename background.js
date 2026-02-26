const DEBOUNCE_MS = 300;
const RETRY_AFTER_FAILED_BROADCAST_MS = 1000;
const REDUCED_VOLUME = 0.3;
const FULL_VOLUME = 1.0;
const MODE_STORAGE_KEY = "duckMode";
const MODE_DUCK = "duck";
const MODE_PAUSE = "pause";
const STORAGE_AREA = chrome.storage?.local ?? chrome.storage?.sync;

const MESSAGE_TYPES = Object.freeze({
  YOUTUBE_STATE: "YOUTUBE_PLAYBACK_STATE",
  GET_YOUTUBE_STATE: "GET_YOUTUBE_STATE",
  INSTAGRAM_STATE: "INSTAGRAM_PLAYBACK_STATE",
  GET_INSTAGRAM_STATE: "GET_INSTAGRAM_STATE",
  SET_SPOTIFY_VOLUME: "SET_SPOTIFY_VOLUME",
  PAUSE_SPOTIFY: "PAUSE_SPOTIFY",
  RESUME_SPOTIFY: "RESUME_SPOTIFY",
});

const CONTENT_SCRIPTS = Object.freeze({
  YOUTUBE: "youtube_content.js",
  INSTAGRAM: "instagram_content.js",
  SPOTIFY: "spotify_content.js",
});

const URL_MATCHES = Object.freeze({
  YOUTUBE: [
    "*://www.youtube.com/*",
    "*://youtube.com/*",
    "*://m.youtube.com/*",
  ],
  INSTAGRAM: [
    "*://www.instagram.com/*",
    "*://instagram.com/*",
    "*://m.instagram.com/*",
  ],
  SPOTIFY: ["*://open.spotify.com/*"],
});

const youtubeTabStates = new Map();
const instagramTabStates = new Map();

let evaluationTimer = null;
let retryTimer = null;
let desiredSpotifyVolume = FULL_VOLUME;
let lastBroadcastVolume = null;
let lastPauseState = null;
let activeTabId = null;
let currentMode = MODE_DUCK;

function parseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch (_error) {
    return null;
  }
}

function isYouTubeHost(hostname) {
  return (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com"
  );
}

function isInstagramHost(hostname) {
  return (
    hostname === "instagram.com" ||
    hostname === "www.instagram.com" ||
    hostname === "m.instagram.com"
  );
}

function isYouTubeUrl(urlString) {
  const parsed = parseUrl(urlString);
  return Boolean(parsed && isYouTubeHost(parsed.hostname.toLowerCase()));
}

function isInstagramUrl(urlString) {
  const parsed = parseUrl(urlString);
  return Boolean(parsed && isInstagramHost(parsed.hostname.toLowerCase()));
}

function isYouTubeVideoUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed || !isYouTubeHost(parsed.hostname.toLowerCase())) {
    return false;
  }

  return (
    (parsed.pathname === "/watch" && parsed.searchParams.has("v")) ||
    parsed.pathname.startsWith("/shorts/")
  );
}

function isInstagramVideoUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed || !isInstagramHost(parsed.hostname.toLowerCase())) {
    return false;
  }

  return true;
}

function isSpotifyUrl(urlString) {
  const parsed = parseUrl(urlString);
  return Boolean(parsed && parsed.hostname.toLowerCase() === "open.spotify.com");
}

function normalizePlaybackState(response) {
  if (
    !response ||
    typeof response.isPlaying !== "boolean" ||
    typeof response.onVideoPage !== "boolean"
  ) {
    return null;
  }

  return {
    isPlaying: response.isPlaying,
    onVideoPage: response.onVideoPage,
    url: typeof response.url === "string" ? response.url : "",
    updatedAt: Date.now(),
  };
}

function isMissingReceiverError(errorLike) {
  const message =
    typeof errorLike === "string"
      ? errorLike
      : errorLike?.message ?? String(errorLike ?? "");

  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection")
  );
}

async function ensureContentScriptInjected(tabId, scriptFile) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    });
    return true;
  } catch (error) {
    console.warn(
      `[SpotifyDuck] Failed to inject ${scriptFile} into tab ${tabId}.`,
      error
    );
    return false;
  }
}

async function sendMessageWithAutoInjection(tabId, payload, scriptFile) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    const injected = await ensureContentScriptInjected(tabId, scriptFile);
    if (!injected) {
      throw error;
    }

    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function injectScriptsIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        ...URL_MATCHES.YOUTUBE,
        ...URL_MATCHES.INSTAGRAM,
        ...URL_MATCHES.SPOTIFY,
      ],
    });

    await Promise.all(
      tabs.map(async (tab) => {
        if (typeof tab.id !== "number") {
          return;
        }

        const url = tab.url ?? "";
        if (isYouTubeUrl(url)) {
          await ensureContentScriptInjected(tab.id, CONTENT_SCRIPTS.YOUTUBE);
        }
        if (isInstagramUrl(url)) {
          await ensureContentScriptInjected(tab.id, CONTENT_SCRIPTS.INSTAGRAM);
        }
        if (isSpotifyUrl(url)) {
          await ensureContentScriptInjected(tab.id, CONTENT_SCRIPTS.SPOTIFY);
        }
      })
    );
  } catch (error) {
    console.warn("[SpotifyDuck] Failed while injecting scripts into open tabs.", error);
  }
}

function clearRetryEvaluation() {
  if (!retryTimer) {
    return;
  }

  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetryEvaluation() {
  if (retryTimer) {
    return;
  }

  retryTimer = setTimeout(() => {
    retryTimer = null;
    scheduleVolumeEvaluation();
  }, RETRY_AFTER_FAILED_BROADCAST_MS);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  activeTabId = tab?.id ?? null;
  return tab ?? null;
}

function loadModeFromStorage() {
  if (!STORAGE_AREA) {
    return;
  }

  STORAGE_AREA.get({ [MODE_STORAGE_KEY]: MODE_DUCK }, (result) => {
    const nextMode =
      result?.[MODE_STORAGE_KEY] === MODE_PAUSE ? MODE_PAUSE : MODE_DUCK;
    updateMode(nextMode);
  });
}

function updateMode(nextMode) {
  if (nextMode !== MODE_DUCK && nextMode !== MODE_PAUSE) {
    return;
  }

  if (nextMode === currentMode) {
    return;
  }

  currentMode = nextMode;
  lastPauseState = null;
  if (currentMode === MODE_PAUSE) {
    void broadcastSpotifyVolume(FULL_VOLUME).then(() => {
      lastBroadcastVolume = FULL_VOLUME;
      scheduleVolumeEvaluation();
    });
  } else {
    void broadcastSpotifyPlayback(MESSAGE_TYPES.RESUME_SPOTIFY);
    scheduleVolumeEvaluation();
  }
}

async function requestYouTubeState(tabId) {
  try {
    const response = await sendMessageWithAutoInjection(
      tabId,
      { type: MESSAGE_TYPES.GET_YOUTUBE_STATE },
      CONTENT_SCRIPTS.YOUTUBE
    );

    const normalizedState = normalizePlaybackState(response);
    if (normalizedState) {
      youtubeTabStates.set(tabId, normalizedState);
      return normalizedState;
    }
  } catch (_error) {
    // The active tab may not currently have a reachable YouTube content script.
  }

  return youtubeTabStates.get(tabId) ?? null;
}

async function requestInstagramState(tabId) {
  try {
    const response = await sendMessageWithAutoInjection(
      tabId,
      { type: MESSAGE_TYPES.GET_INSTAGRAM_STATE },
      CONTENT_SCRIPTS.INSTAGRAM
    );

    const normalizedState = normalizePlaybackState(response);
    if (normalizedState) {
      instagramTabStates.set(tabId, normalizedState);
      return normalizedState;
    }
  } catch (_error) {
    // The tab may not currently have a reachable Instagram content script.
  }

  return instagramTabStates.get(tabId) ?? null;
}

function stateIndicatesPlaying(state) {
  if (!state) {
    return false;
  }

  const onVideoPage =
    state.onVideoPage ||
    (state.url &&
      (isYouTubeVideoUrl(state.url) || isInstagramVideoUrl(state.url)));

  return Boolean(state.isPlaying && onVideoPage);
}

function shouldPauseFromKnownStates() {
  for (const state of youtubeTabStates.values()) {
    if (stateIndicatesPlaying(state)) {
      return true;
    }
  }

  for (const state of instagramTabStates.values()) {
    if (stateIndicatesPlaying(state)) {
      return true;
    }
  }

  return false;
}

async function refreshYouTubeStates() {
  const youtubeTabs = await chrome.tabs.query({ url: URL_MATCHES.YOUTUBE });

  await Promise.all(
    youtubeTabs
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number")
      .map((tabId) => requestYouTubeState(tabId))
  );
}

async function refreshInstagramStates() {
  const instagramTabs = await chrome.tabs.query({ url: URL_MATCHES.INSTAGRAM });

  await Promise.all(
    instagramTabs
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number")
      .map((tabId) => requestInstagramState(tabId))
  );
}

async function shouldPauseSpotify() {
  if (shouldPauseFromKnownStates()) {
    return true;
  }

  await Promise.all([refreshYouTubeStates(), refreshInstagramStates()]);
  return shouldPauseFromKnownStates();
}

async function shouldReduceSpotifyVolume() {
  const activeTab = await getActiveTab();
  if (
    !activeTab?.id ||
    (!isYouTubeUrl(activeTab.url ?? "") && !isInstagramUrl(activeTab.url ?? ""))
  ) {
    return false;
  }

  const knownState = isYouTubeUrl(activeTab.url ?? "")
    ? youtubeTabStates.get(activeTab.id) ??
      (await requestYouTubeState(activeTab.id))
    : instagramTabStates.get(activeTab.id) ??
      (await requestInstagramState(activeTab.id));

  if (!knownState) {
    return false;
  }

  const activeTabOnVideoPage =
    isYouTubeVideoUrl(activeTab.url ?? "") ||
    isInstagramVideoUrl(activeTab.url ?? "");
  return Boolean(
    knownState.isPlaying && knownState.onVideoPage && activeTabOnVideoPage
  );
}

async function setSpotifyVolumeForTab(tabId, volume) {
  try {
    const response = await sendMessageWithAutoInjection(
      tabId,
      {
        type: MESSAGE_TYPES.SET_SPOTIFY_VOLUME,
        volume,
      },
      CONTENT_SCRIPTS.SPOTIFY
    );
    return response?.success === true;
  } catch (error) {
    console.warn(
      `[SpotifyDuck] Unable to set volume in Spotify tab ${tabId}.`,
      error
    );
    return false;
  }
}

async function setSpotifyPlaybackForTab(tabId, type) {
  try {
    const response = await sendMessageWithAutoInjection(
      tabId,
      { type },
      CONTENT_SCRIPTS.SPOTIFY
    );
    return response?.success === true;
  } catch (error) {
    console.warn(
      `[SpotifyDuck] Unable to ${type.toLowerCase()} in Spotify tab ${tabId}.`,
      error
    );
    return false;
  }
}

async function broadcastSpotifyPlayback(type) {
  const spotifyTabs = await chrome.tabs.query({
    url: URL_MATCHES.SPOTIFY,
  });

  if (spotifyTabs.length === 0) {
    return { applied: false, noSpotifyTabs: true };
  }

  const results = await Promise.all(
    spotifyTabs
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number")
      .map((tabId) => setSpotifyPlaybackForTab(tabId, type))
  );

  const anySuccess = results.some(Boolean);
  if (!anySuccess) {
    console.warn("[SpotifyDuck] No Spotify tab accepted the playback command.");
  }
  return { applied: anySuccess, noSpotifyTabs: false };
}

async function broadcastSpotifyVolume(volume) {
  const spotifyTabs = await chrome.tabs.query({
    url: URL_MATCHES.SPOTIFY,
  });

  if (spotifyTabs.length === 0) {
    return { applied: false, noSpotifyTabs: true };
  }

  const results = await Promise.all(
    spotifyTabs
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number")
      .map((tabId) => setSpotifyVolumeForTab(tabId, volume))
  );

  const anySuccess = results.some(Boolean);
  if (!anySuccess) {
    console.warn("[SpotifyDuck] No Spotify tab accepted the volume command.");
  }
  return { applied: anySuccess, noSpotifyTabs: false };
}

async function evaluateAndApplyVolume() {
  try {
    if (currentMode === MODE_PAUSE) {
      desiredSpotifyVolume = FULL_VOLUME;
      if (lastBroadcastVolume !== FULL_VOLUME) {
        void broadcastSpotifyVolume(FULL_VOLUME).then(() => {
          lastBroadcastVolume = FULL_VOLUME;
        });
      }

      const nextPauseState = await shouldPauseSpotify();
      if (nextPauseState === lastPauseState) {
        clearRetryEvaluation();
        return;
      }

      const broadcastResult = await broadcastSpotifyPlayback(
        nextPauseState ? MESSAGE_TYPES.PAUSE_SPOTIFY : MESSAGE_TYPES.RESUME_SPOTIFY
      );
      if (broadcastResult.applied || broadcastResult.noSpotifyTabs) {
        lastPauseState = nextPauseState;
        clearRetryEvaluation();
        return;
      }

      scheduleRetryEvaluation();
      return;
    }

    const shouldReduce = await shouldPauseSpotify();
    const targetVolume = shouldReduce ? REDUCED_VOLUME : FULL_VOLUME;
    desiredSpotifyVolume = targetVolume;

    if (targetVolume === lastBroadcastVolume) {
      clearRetryEvaluation();
      return;
    }

    const broadcastResult = await broadcastSpotifyVolume(targetVolume);
    if (broadcastResult.applied || broadcastResult.noSpotifyTabs) {
      lastBroadcastVolume = targetVolume;
      clearRetryEvaluation();
      return;
    }

    scheduleRetryEvaluation();
  } catch (error) {
    console.error("[SpotifyDuck] Failed while evaluating volume state.", error);
    scheduleRetryEvaluation();
  }
}

function scheduleVolumeEvaluation() {
  if (evaluationTimer) {
    clearTimeout(evaluationTimer);
  }

  evaluationTimer = setTimeout(() => {
    evaluationTimer = null;
    void evaluateAndApplyVolume();
  }, DEBOUNCE_MS);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) {
    return;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return;
  }

  if (message.type === MESSAGE_TYPES.YOUTUBE_STATE) {
    youtubeTabStates.set(tabId, {
      isPlaying: Boolean(message.isPlaying),
      onVideoPage: Boolean(message.onVideoPage),
      url: typeof message.url === "string" ? message.url : sender.tab?.url ?? "",
      updatedAt: Date.now(),
    });
  } else if (message.type === MESSAGE_TYPES.INSTAGRAM_STATE) {
    instagramTabStates.set(tabId, {
      isPlaying: Boolean(message.isPlaying),
      onVideoPage: Boolean(message.onVideoPage),
      url: typeof message.url === "string" ? message.url : sender.tab?.url ?? "",
      updatedAt: Date.now(),
    });
  } else {
    return;
  }

  scheduleVolumeEvaluation();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
  scheduleVolumeEvaluation();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url ?? tab.url ?? "";

  if (changeInfo.url) {
    if (!isYouTubeUrl(nextUrl)) {
      youtubeTabStates.delete(tabId);
    } else {
      const previousState = youtubeTabStates.get(tabId);
      if (previousState) {
        youtubeTabStates.set(tabId, {
          ...previousState,
          isPlaying: false,
          onVideoPage: isYouTubeVideoUrl(nextUrl),
          url: nextUrl,
          updatedAt: Date.now(),
        });
      }
    }

    if (!isInstagramUrl(nextUrl)) {
      instagramTabStates.delete(tabId);
    } else {
      const previousState = instagramTabStates.get(tabId);
      if (previousState) {
        instagramTabStates.set(tabId, {
          ...previousState,
          isPlaying: false,
          onVideoPage: isInstagramVideoUrl(nextUrl),
          url: nextUrl,
          updatedAt: Date.now(),
        });
      }
    }
  }

  if (isSpotifyUrl(nextUrl) && changeInfo.status === "complete") {
    void setSpotifyVolumeForTab(tabId, desiredSpotifyVolume).then((success) => {
      if (success) {
        lastBroadcastVolume = desiredSpotifyVolume;
        clearRetryEvaluation();
      } else {
        scheduleRetryEvaluation();
      }
    });
  }

  if (tabId === activeTabId || Boolean(changeInfo.url) || isSpotifyUrl(nextUrl)) {
    scheduleVolumeEvaluation();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  youtubeTabStates.delete(tabId);
  instagramTabStates.delete(tabId);

  if (tabId === activeTabId) {
    activeTabId = null;
  }

  scheduleVolumeEvaluation();
});

chrome.windows.onFocusChanged.addListener(() => {
  scheduleVolumeEvaluation();
});

chrome.runtime.onInstalled.addListener(() => {
  void injectScriptsIntoExistingTabs();
  loadModeFromStorage();
  scheduleVolumeEvaluation();
});

chrome.runtime.onStartup.addListener(() => {
  void injectScriptsIntoExistingTabs();
  loadModeFromStorage();
  scheduleVolumeEvaluation();
});

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      !changes[MODE_STORAGE_KEY] ||
      (STORAGE_AREA === chrome.storage?.local && areaName !== "local") ||
      (STORAGE_AREA === chrome.storage?.sync && areaName !== "sync")
    ) {
      return;
    }
    const nextValue = changes[MODE_STORAGE_KEY].newValue;
    updateMode(nextValue);
  });
}

loadModeFromStorage();
scheduleVolumeEvaluation();
