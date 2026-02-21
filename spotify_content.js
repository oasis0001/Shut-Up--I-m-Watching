(() => {
  if (window.__spotifyDuckSpotifyInitialized) {
    return;
  }
  window.__spotifyDuckSpotifyInitialized = true;

const MESSAGE_TYPES = Object.freeze({
  SET_SPOTIFY_VOLUME: "SET_SPOTIFY_VOLUME",
  PAUSE_SPOTIFY: "PAUSE_SPOTIFY",
  RESUME_SPOTIFY: "RESUME_SPOTIFY",
});

  const VOLUME_EPSILON = 0.02;
  const UI_VOLUME_EPSILON = 0.03;
  const VOLUME_UNITS_PER_SECOND = 3.0;
  const TRANSITION_TICK_MS = 32;
  const MAX_EFFECTIVE_DELTA_MS = 120;
  const PLAYBACK_RETRY_MS = 200;

let desiredVolume = 1;
let observedAudioElement = null;
let domObserver = null;
let transitionTimerId = null;
let transitionQueued = false;
let lastTransitionTimestamp = 0;
let directFailureLogged = false;
let pausedByExtension = false;
  let pendingPlaybackAction = null;
  let playbackRetryTimerId = null;

  function isCloseTo(left, right, epsilon = VOLUME_EPSILON) {
    return Math.abs(left - right) <= epsilon;
  }

  function collectSearchRoots(root, output) {
    if (!root || !output) {
      return;
    }

    output.push(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      if (currentNode.shadowRoot) {
        collectSearchRoots(currentNode.shadowRoot, output);
      }
      currentNode = walker.nextNode();
    }
  }

  function findFirstMatchingElement(selectors) {
    const roots = [];
    collectSearchRoots(document, roots);

    for (const root of roots) {
      for (const selector of selectors) {
        const match = root.querySelector(selector);
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  function collectAudioElements(root, outputSet) {
    if (!root || !outputSet) {
      return;
    }

    for (const audioElement of root.querySelectorAll("audio")) {
      outputSet.add(audioElement);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      if (currentNode.shadowRoot) {
        collectAudioElements(currentNode.shadowRoot, outputSet);
      }
      currentNode = walker.nextNode();
    }
  }

  function getAudioElements() {
    const root = document.documentElement;
    if (!root) {
      return [];
    }

    const audioSet = new Set();
    collectAudioElements(document, audioSet);
    return Array.from(audioSet);
  }

  function pickMainAudioElement(audioElements) {
    if (audioElements.length === 0) {
      return null;
    }

    const active = audioElements.find((audio) => !audio.paused && !audio.ended);
    if (active) {
      return active;
    }

    const progressed = audioElements.find(
      (audio) => audio.currentTime > 0 && !audio.ended
    );
    if (progressed) {
      return progressed;
    }

    const withSource = audioElements.find(
      (audio) => typeof audio.src === "string" && audio.src.length > 0
    );
    if (withSource) {
      return withSource;
    }

    return audioElements[0];
  }

  function findMainAudioElement() {
    return pickMainAudioElement(getAudioElements());
  }

  function findVolumeRangeInput() {
    const element = findFirstMatchingElement([
      "input[data-testid='volume-bar']",
      "[data-testid='volume-bar'] input[type='range']",
      "input[type='range'][aria-label*='Volume']",
      "input[type='range'][aria-label*='volume']",
    ]);

    return element instanceof HTMLInputElement ? element : null;
  }

  function setNativeInputValue(inputElement, value) {
    const prototype = Object.getPrototypeOf(inputElement);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(inputElement, value);
      return;
    }

    inputElement.value = value;
  }

  function getVolumeRangeBounds(inputElement) {
    const min = Number(inputElement.min);
    const max = Number(inputElement.max);
    const safeMin = Number.isFinite(min) ? min : 0;
    const safeMax = Number.isFinite(max) ? max : 1;
    return { safeMin, safeMax };
  }

  function getNormalizedInputVolume(inputElement) {
    const { safeMin, safeMax } = getVolumeRangeBounds(inputElement);
    if (safeMax <= safeMin) {
      return null;
    }

    const current = Number(inputElement.value);
    if (!Number.isFinite(current)) {
      return null;
    }

    return (current - safeMin) / (safeMax - safeMin);
  }

  function applyVolumeViaRangeInput(inputElement, volume, final) {
    if (!inputElement) {
      return false;
    }

    const currentNormalized = getNormalizedInputVolume(inputElement);
    if (
      currentNormalized !== null &&
      isCloseTo(currentNormalized, volume, UI_VOLUME_EPSILON)
    ) {
      return true;
    }

    const { safeMin, safeMax } = getVolumeRangeBounds(inputElement);
    const targetNumeric = safeMin + volume * (safeMax - safeMin);
    setNativeInputValue(inputElement, String(targetNumeric));
    inputElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (final) {
      inputElement.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    return true;
  }

  function applyDirectVolume(audioElement, volume) {
    if (!audioElement) {
      return false;
    }

    if (isCloseTo(audioElement.volume, volume)) {
      directFailureLogged = false;
      return true;
    }

    try {
      audioElement.volume = volume;
    } catch (error) {
      if (!directFailureLogged) {
        console.error(
          "[SpotifyDuck] Direct volume control failed while writing to audio.volume.",
          error
        );
        directFailureLogged = true;
      }
      return false;
    }

    if (!isCloseTo(audioElement.volume, volume)) {
      if (!directFailureLogged) {
        console.error(
          "[SpotifyDuck] Direct volume control failed: audio.volume did not update."
        );
        directFailureLogged = true;
      }
      return false;
    }

    directFailureLogged = false;
    return true;
  }

  function removeObservedAudioListeners() {
    if (!observedAudioElement) {
      return;
    }

    observedAudioElement.removeEventListener("play", handleObservedAudioEvent);
    observedAudioElement.removeEventListener(
      "loadedmetadata",
      handleObservedAudioEvent
    );
    observedAudioElement.removeEventListener("emptied", handleObservedAudioEvent);
    observedAudioElement = null;
  }

  function observeAudioElement(audioElement) {
    if (audioElement === observedAudioElement) {
      return;
    }

    removeObservedAudioListeners();
    if (!audioElement) {
      return;
    }

    observedAudioElement = audioElement;
    observedAudioElement.addEventListener("play", handleObservedAudioEvent);
    observedAudioElement.addEventListener("loadedmetadata", handleObservedAudioEvent);
    observedAudioElement.addEventListener("emptied", handleObservedAudioEvent);
  }

  function resolveControls() {
    const audioElement = findMainAudioElement();
    observeAudioElement(audioElement);
    const rangeInput = findVolumeRangeInput();
    return { audioElement, rangeInput };
  }

  function readCurrentVolume(controls) {
    if (
      controls.audioElement &&
      Number.isFinite(controls.audioElement.volume) &&
      controls.audioElement.volume >= 0 &&
      controls.audioElement.volume <= 1
    ) {
      return controls.audioElement.volume;
    }

    if (controls.rangeInput) {
      const normalized = getNormalizedInputVolume(controls.rangeInput);
      if (normalized !== null) {
        return normalized;
      }
    }

    return null;
  }

  function applyVolumeStep(controls, volume, final) {
    const directApplied = applyDirectVolume(controls.audioElement, volume);
    if (directApplied) {
      if (final && controls.rangeInput) {
        applyVolumeViaRangeInput(controls.rangeInput, volume, true);
      }
      return true;
    }

    return applyVolumeViaRangeInput(controls.rangeInput, volume, final);
  }

  function stopTransition() {
    if (transitionTimerId !== null) {
      clearTimeout(transitionTimerId);
      transitionTimerId = null;
    }

    lastTransitionTimestamp = 0;
  }

  function scheduleTransition() {
    if (transitionQueued) {
      return;
    }

    transitionQueued = true;
    queueMicrotask(() => {
      transitionQueued = false;
      if (transitionTimerId !== null) {
        return;
      }

      lastTransitionTimestamp = 0;
      transitionTimerId = setTimeout(runTransitionFrame, 0);
    });
  }

  function runTransitionFrame() {
    transitionTimerId = null;
    const now = performance.now();

    const controls = resolveControls();
    if (!controls.audioElement && !controls.rangeInput) {
      stopTransition();
      return;
    }

    const currentVolume = readCurrentVolume(controls);
    if (currentVolume === null) {
      applyVolumeStep(controls, desiredVolume, true);
      stopTransition();
      return;
    }

    const rawDeltaMs = lastTransitionTimestamp
      ? Math.max(1, now - lastTransitionTimestamp)
      : TRANSITION_TICK_MS;
    const deltaMs = Math.min(rawDeltaMs, MAX_EFFECTIVE_DELTA_MS);
    lastTransitionTimestamp = now;

    const difference = desiredVolume - currentVolume;
    if (Math.abs(difference) <= VOLUME_EPSILON) {
      applyVolumeStep(controls, desiredVolume, true);
      stopTransition();
      return;
    }

    const maxStep = (VOLUME_UNITS_PER_SECOND * deltaMs) / 1000;
    const nextVolume =
      currentVolume + Math.sign(difference) * Math.min(Math.abs(difference), maxStep);

    const applied = applyVolumeStep(controls, nextVolume, false);
    if (!applied) {
      stopTransition();
      return;
    }

    transitionTimerId = setTimeout(runTransitionFrame, TRANSITION_TICK_MS);
  }

  function handleObservedAudioEvent() {
    scheduleTransition();
    applyPlaybackAction();
  }

function ensureDomObserver() {
    if (domObserver) {
      return;
    }

    const root = document.documentElement ?? document;
    domObserver = new MutationObserver(() => {
      if (transitionTimerId !== null) {
        return;
      }

      if (!observedAudioElement || !observedAudioElement.isConnected) {
        scheduleTransition();
      }

      if (pendingPlaybackAction) {
        applyPlaybackAction();
      }
    });
    domObserver.observe(root, { childList: true, subtree: true });
}

  function getPlaybackAudioElement() {
    return findMainAudioElement();
  }

  function findPlayPauseButton() {
    const element = findFirstMatchingElement([
      "button[data-testid='control-button-playpause']",
      "button[aria-label='Pause']",
      "button[aria-label='Play']",
      "button[aria-label*='Pause']",
      "button[aria-label*='Play']",
    ]);

    return element instanceof HTMLButtonElement ? element : null;
  }

  function getButtonState(button) {
    if (!button) {
      return null;
    }

    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("pause")) {
      return "playing";
    }
    if (label.includes("play")) {
      return "paused";
    }
    return null;
  }

  function pauseWithButton() {
    const button = findPlayPauseButton();
    if (!button) {
      return false;
    }
    if (getButtonState(button) === "paused") {
      return true;
    }
    button.click();
    return true;
  }

  function resumeWithButton() {
    const button = findPlayPauseButton();
    if (!button) {
      return false;
    }
    if (getButtonState(button) === "playing") {
      return true;
    }
    button.click();
    return true;
  }

  function pauseSpotify(audioElement) {
    if (audioElement && !audioElement.paused) {
      audioElement.pause();
      if (audioElement.paused) {
        pausedByExtension = true;
        return true;
      }
    }

    if (pauseWithButton()) {
      pausedByExtension = true;
      return true;
    }

    return false;
  }

  function resumeSpotify(audioElement) {
    if (!pausedByExtension) {
      return true;
    }

    let resumed = false;
    if (audioElement && audioElement.paused) {
      const playPromise = audioElement.play();
      resumed = true;
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((error) => {
          console.error("[SpotifyDuck] Failed to resume Spotify playback.", error);
        });
      }
    }

    if (!resumed) {
      resumed = resumeWithButton();
    }

    if (resumed) {
      pausedByExtension = false;
    }

    return resumed;
  }

  function applyPlaybackAction() {
    if (!pendingPlaybackAction) {
      return;
    }

    const audioElement = getPlaybackAudioElement();

    if (pendingPlaybackAction === MESSAGE_TYPES.PAUSE_SPOTIFY) {
      if (pauseSpotify(audioElement)) {
        pendingPlaybackAction = null;
        clearPlaybackRetry();
      }
      schedulePlaybackRetry();
      return;
    }

    if (pendingPlaybackAction === MESSAGE_TYPES.RESUME_SPOTIFY) {
      if (resumeSpotify(audioElement)) {
        pendingPlaybackAction = null;
        clearPlaybackRetry();
      }
      schedulePlaybackRetry();
    }
  }

  function clearPlaybackRetry() {
    if (playbackRetryTimerId !== null) {
      clearTimeout(playbackRetryTimerId);
      playbackRetryTimerId = null;
    }
  }

  function schedulePlaybackRetry() {
    if (!pendingPlaybackAction || playbackRetryTimerId !== null) {
      return;
    }

    playbackRetryTimerId = setTimeout(() => {
      playbackRetryTimerId = null;
      applyPlaybackAction();
    }, PLAYBACK_RETRY_MS);
  }

async function setDesiredVolume(volume) {
  desiredVolume = volume;
  ensureDomObserver();
  scheduleTransition();
  return true;
}

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === MESSAGE_TYPES.SET_SPOTIFY_VOLUME) {
      const volume = Number(message.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        console.error("[SpotifyDuck] Received invalid volume value:", message.volume);
        sendResponse({ success: false });
        return;
      }

      void setDesiredVolume(volume)
        .then((success) => sendResponse({ success }))
        .catch((error) => {
          console.error("[SpotifyDuck] Unexpected error while setting volume.", error);
          sendResponse({ success: false });
        });

      return true;
    }

    if (
      message.type === MESSAGE_TYPES.PAUSE_SPOTIFY ||
      message.type === MESSAGE_TYPES.RESUME_SPOTIFY
    ) {
      pendingPlaybackAction = message.type;
      applyPlaybackAction();
      sendResponse({ success: true });
      return;
    }
  });
})();
