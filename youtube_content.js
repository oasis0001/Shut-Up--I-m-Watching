(() => {
  if (window.__spotifyDuckYouTubeInitialized) {
    return;
  }
  window.__spotifyDuckYouTubeInitialized = true;

  const MESSAGE_TYPES = Object.freeze({
    YOUTUBE_STATE: "YOUTUBE_PLAYBACK_STATE",
    GET_YOUTUBE_STATE: "GET_YOUTUBE_STATE",
  });

  const VIDEO_EVENTS = [
    "play",
    "playing",
    "pause",
    "ended",
    "emptied",
    "abort",
    "stalled",
    "waiting",
    "suspend",
    "loadeddata",
  ];

  const URL_CHANGE_EVENT = "spotify-duck:url-change";

  let currentVideo = null;
  let stateQueued = false;
  let lastSentSignature = "";
  let trackedUrl = window.location.href;
  let mutationQueued = false;
  let runtimeDisconnected = false;

  function parseUrl(urlString) {
    try {
      return new URL(urlString);
    } catch (_error) {
      return null;
    }
  }

  function isVideoPage(urlString = window.location.href) {
    const parsed = parseUrl(urlString);
    if (!parsed) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (
      host !== "youtube.com" &&
      host !== "www.youtube.com" &&
      host !== "m.youtube.com"
    ) {
      return false;
    }

    return (
      (parsed.pathname === "/watch" && parsed.searchParams.has("v")) ||
      parsed.pathname.startsWith("/shorts/")
    );
  }

  function getPlaybackState() {
    return {
      isPlaying: Boolean(
        currentVideo &&
          !currentVideo.paused &&
          !currentVideo.ended &&
          currentVideo.readyState > 0
      ),
      onVideoPage: isVideoPage(),
      url: window.location.href,
    };
  }

  function isContextInvalidatedError(errorLike) {
    const message =
      typeof errorLike === "string"
        ? errorLike
        : errorLike?.message ?? String(errorLike ?? "");

    return message.includes("Extension context invalidated");
  }

  function canUseRuntime() {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
    return Boolean(
      !runtimeDisconnected && runtime && typeof runtime.id === "string"
    );
  }

  function markRuntimeDisconnected() {
    runtimeDisconnected = true;
  }

  function safeSendRuntimeMessage(payload) {
    if (!canUseRuntime()) {
      return;
    }

    try {
      chrome.runtime.sendMessage(payload, () => {
        try {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError && isContextInvalidatedError(runtimeError.message)) {
            markRuntimeDisconnected();
          }
        } catch (error) {
          if (isContextInvalidatedError(error)) {
            markRuntimeDisconnected();
            return;
          }

          console.warn("[SpotifyDuck] Failed to read runtime error state.", error);
        }
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        markRuntimeDisconnected();
        return;
      }

      console.warn("[SpotifyDuck] Failed to send YouTube playback state.", error);
    }
  }

  function sendState(force = false) {
    const nextState = getPlaybackState();
    const signature = `${nextState.isPlaying}|${nextState.onVideoPage}|${nextState.url}`;

    if (!force && signature === lastSentSignature) {
      return;
    }

    lastSentSignature = signature;

    safeSendRuntimeMessage({
      type: MESSAGE_TYPES.YOUTUBE_STATE,
      ...nextState,
    });
  }

  function scheduleStateSend() {
    if (stateQueued) {
      return;
    }

    stateQueued = true;
    queueMicrotask(() => {
      stateQueued = false;
      sendState();
    });
  }

  function onPlaybackEvent() {
    scheduleStateSend();
  }

  function removeVideoListeners(videoElement) {
    for (const eventName of VIDEO_EVENTS) {
      videoElement.removeEventListener(eventName, onPlaybackEvent);
    }
  }

  function addVideoListeners(videoElement) {
    for (const eventName of VIDEO_EVENTS) {
      videoElement.addEventListener(eventName, onPlaybackEvent);
    }
  }

  function findVideoElement() {
    return (
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video")
    );
  }

  function refreshVideoBinding() {
    const nextVideo = findVideoElement();
    if (nextVideo === currentVideo) {
      return;
    }

    if (currentVideo) {
      removeVideoListeners(currentVideo);
    }

    currentVideo = nextVideo;

    if (currentVideo) {
      addVideoListeners(currentVideo);
    }

    scheduleStateSend();
  }

  function handleUrlChange() {
    const nextUrl = window.location.href;
    if (nextUrl === trackedUrl) {
      return;
    }

    trackedUrl = nextUrl;
    lastSentSignature = "";
    refreshVideoBinding();
    scheduleStateSend();
  }

  function queueMutationCheck() {
    if (mutationQueued) {
      return;
    }

    mutationQueued = true;
    queueMicrotask(() => {
      mutationQueued = false;
      refreshVideoBinding();
      handleUrlChange();
    });
  }

  function dispatchSyntheticUrlChange() {
    window.dispatchEvent(new Event(URL_CHANGE_EVENT));
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (typeof original !== "function") {
      return;
    }

    history[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      dispatchSyntheticUrlChange();
      return result;
    };
  }

  function initialize() {
    patchHistoryMethod("pushState");
    patchHistoryMethod("replaceState");

    window.addEventListener(URL_CHANGE_EVENT, handleUrlChange);
    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
    window.addEventListener("yt-navigate-finish", handleUrlChange);
    document.addEventListener("visibilitychange", scheduleStateSend);

    const root = document.documentElement ?? document;
    const observer = new MutationObserver(queueMutationCheck);
    observer.observe(root, { childList: true, subtree: true });

    refreshVideoBinding();
    scheduleStateSend();
  }

  if (canUseRuntime()) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.type !== MESSAGE_TYPES.GET_YOUTUBE_STATE) {
          return;
        }

        sendResponse(getPlaybackState());
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        markRuntimeDisconnected();
      } else {
        console.warn("[SpotifyDuck] Failed to register runtime listener.", error);
      }
    }
  }

  initialize();
})();
