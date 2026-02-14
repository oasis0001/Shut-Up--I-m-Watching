(() => {
  if (window.__spotifyDuckSpotifyInitialized) {
    return;
  }
  window.__spotifyDuckSpotifyInitialized = true;

  const MESSAGE_TYPES = Object.freeze({
    SET_SPOTIFY_VOLUME: "SET_SPOTIFY_VOLUME",
  });

  const VOLUME_EPSILON = 0.02;

  let desiredVolume = 1;
  let observedAudioElement = null;
  let domObserver = null;
  let resolveQueued = false;
  let resolveForce = false;

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

  function applyVolumeViaRangeInput(volume, force = false) {
    const inputElement = findVolumeRangeInput();
    if (!inputElement) {
      return false;
    }

    const normalizedCurrent = getNormalizedInputVolume(inputElement);
    if (
      !force &&
      normalizedCurrent !== null &&
      isCloseTo(normalizedCurrent, volume, 0.03)
    ) {
      return true;
    }

    const { safeMin, safeMax } = getVolumeRangeBounds(inputElement);
    const targetNumeric = safeMin + volume * (safeMax - safeMin);
    setNativeInputValue(inputElement, String(targetNumeric));
    inputElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputElement.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return true;
  }

  function applyDirectVolume(audioElement, volume, force = false) {
    if (!force && isCloseTo(audioElement.volume, volume)) {
      return true;
    }

    try {
      audioElement.volume = volume;
    } catch (error) {
      console.error(
        "[SpotifyDuck] Direct volume control failed while writing to audio.volume.",
        error
      );
      return false;
    }

    if (!isCloseTo(audioElement.volume, volume)) {
      console.error(
        "[SpotifyDuck] Direct volume control failed: audio.volume did not update."
      );
      return false;
    }

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
    if (observedAudioElement === audioElement) {
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

  function resolveAndApply(force = false) {
    const audioElement = findMainAudioElement();
    if (audioElement !== observedAudioElement) {
      observeAudioElement(audioElement);
    }

    let directApplied = false;
    if (audioElement) {
      directApplied = applyDirectVolume(audioElement, desiredVolume, force);
    }

    const uiApplied = applyVolumeViaRangeInput(desiredVolume, force);
    return directApplied || uiApplied;
  }

  function scheduleResolveAndApply(force = false) {
    resolveForce = resolveForce || force;
    if (resolveQueued) {
      return;
    }

    resolveQueued = true;
    queueMicrotask(() => {
      resolveQueued = false;
      const forceApply = resolveForce;
      resolveForce = false;
      resolveAndApply(forceApply);
    });
  }

  function handleObservedAudioEvent() {
    scheduleResolveAndApply(false);
  }

  function ensureDomObserver() {
    if (domObserver) {
      return;
    }

    const root = document.documentElement ?? document;
    domObserver = new MutationObserver(() => {
      if (observedAudioElement && observedAudioElement.isConnected) {
        return;
      }

      scheduleResolveAndApply(false);
    });
    domObserver.observe(root, { childList: true, subtree: true });
  }

  async function setDesiredVolume(volume) {
    desiredVolume = volume;
    ensureDomObserver();

    const appliedNow = resolveAndApply(true);
    if (!appliedNow) {
      scheduleResolveAndApply(true);
    }

    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPES.SET_SPOTIFY_VOLUME) {
      return;
    }

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
  });
})();
