(() => {
  if (window.__spotifyDuckInstagramInitialized) {
    return;
  }
  window.__spotifyDuckInstagramInitialized = true;

  const MESSAGE_TYPES = Object.freeze({
    INSTAGRAM_STATE: "INSTAGRAM_PLAYBACK_STATE",
    GET_INSTAGRAM_STATE: "GET_INSTAGRAM_STATE",
  });

  const VIDEO_EVENTS = [
    "play",
    "playing",
    "pause",
    "ended",
    "volumechange",
    "emptied",
    "abort",
    "stalled",
    "waiting",
    "suspend",
    "loadeddata",
  ];

  const URL_CHANGE_EVENT = "spotify-duck:ig-url-change";

  let currentVideo = null;
  let trackedVideos = new Set();
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

  function isInstagramPage(urlString = window.location.href) {
    const parsed = parseUrl(urlString);
    if (!parsed) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    return (
      host === "instagram.com" ||
      host === "www.instagram.com" ||
      host === "m.instagram.com"
    );
  }

  function getPlaybackState() {
    currentVideo = pickPreferredVideoElement(listVideoElements());
    const activeVideoIsAudible = isAudiblePlayingVideo(currentVideo);

    return {
      isPlaying: activeVideoIsAudible,
      onVideoPage: isInstagramPage(),
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

          console.warn(
            "[SpotifyDuck] Failed to read runtime error state.",
            error
          );
        }
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        markRuntimeDisconnected();
        return;
      }

      console.warn("[SpotifyDuck] Failed to send Instagram playback state.", error);
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
      type: MESSAGE_TYPES.INSTAGRAM_STATE,
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

  function onPlaybackEvent(event) {
    if (event?.target instanceof HTMLVideoElement) {
      currentVideo = event.target;
    }
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

  function listVideoElements() {
    return Array.from(document.querySelectorAll("video"));
  }

  function getVideoArea(videoElement) {
    const rect = videoElement.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isVideoVisible(videoElement) {
    const rect = videoElement.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }

    const styles = window.getComputedStyle(videoElement);
    return styles.display !== "none" && styles.visibility !== "hidden";
  }

  function isAudibleVideo(videoElement) {
    return Boolean(videoElement && !videoElement.muted && videoElement.volume > 0.01);
  }

  function isAudiblePlayingVideo(videoElement) {
    return Boolean(
      videoElement &&
        !videoElement.paused &&
        !videoElement.ended &&
        isAudibleVideo(videoElement)
    );
  }

  function pickPreferredVideoElement(videoElements) {
    if (videoElements.length === 0) {
      return null;
    }

    const visibleAudiblePlaying = videoElements.find(
      (videoElement) =>
        isAudiblePlayingVideo(videoElement) && isVideoVisible(videoElement)
    );
    if (visibleAudiblePlaying) {
      return visibleAudiblePlaying;
    }

    const anyAudiblePlaying = videoElements.find((videoElement) =>
      isAudiblePlayingVideo(videoElement)
    );
    if (anyAudiblePlaying) {
      return anyAudiblePlaying;
    }

    const visiblePlaying = videoElements.find(
      (videoElement) =>
        !videoElement.paused && !videoElement.ended && isVideoVisible(videoElement)
    );
    if (visiblePlaying) {
      return visiblePlaying;
    }

    const anyPlaying = videoElements.find(
      (videoElement) => !videoElement.paused && !videoElement.ended
    );
    if (anyPlaying) {
      return anyPlaying;
    }

    const visibleCandidates = videoElements
      .filter(isVideoVisible)
      .sort((left, right) => getVideoArea(right) - getVideoArea(left));

    if (visibleCandidates.length > 0) {
      return visibleCandidates[0];
    }

    return videoElements[0];
  }

  function refreshVideoBinding() {
    const nextVideos = listVideoElements();
    const nextVideoSet = new Set(nextVideos);

    for (const previousVideo of trackedVideos) {
      if (!nextVideoSet.has(previousVideo)) {
        removeVideoListeners(previousVideo);
      }
    }

    for (const nextVideo of nextVideoSet) {
      if (!trackedVideos.has(nextVideo)) {
        addVideoListeners(nextVideo);
      }
    }

    trackedVideos = nextVideoSet;

    const nextCurrentVideo = pickPreferredVideoElement(nextVideos);
    if (nextCurrentVideo === currentVideo) {
      return;
    }

    currentVideo = nextCurrentVideo;
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
        if (!message || message.type !== MESSAGE_TYPES.GET_INSTAGRAM_STATE) {
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
