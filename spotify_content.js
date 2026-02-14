(() => {
  if (window.__spotifyDuckSpotifyInitialized) {
    return;
  }
  window.__spotifyDuckSpotifyInitialized = true;

  const MESSAGE_TYPES = Object.freeze({
    SET_SPOTIFY_VOLUME: "SET_SPOTIFY_VOLUME",
  });

  let desiredVolume = 1;
  let observedAudioElement = null;
  let domObserver = null;
  let applyQueued = false;

  function collectSearchRoots(root, output) {
    if (!root || !output) {
      return;
    }

    output.push(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      const shadowRoot = currentNode.shadowRoot;
      if (shadowRoot) {
        collectSearchRoots(shadowRoot, output);
      }
      currentNode = walker.nextNode();
    }
  }

  function findFirstMatchingElement(selectors) {
    const roots = [];
    collectSearchRoots(document, roots);

    for (const root of roots) {
      for (const selector of selectors) {
        const element = root.querySelector(selector);
        if (element) {
          return element;
        }
      }
    }

    return null;
  }

  function collectAudioElements(root, outputSet) {
    if (!root || !outputSet) {
      return;
    }

    const localAudioElements = root.querySelectorAll("audio");
    for (const audioElement of localAudioElements) {
      outputSet.add(audioElement);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      const shadowRoot = currentNode.shadowRoot;
      if (shadowRoot) {
        collectAudioElements(shadowRoot, outputSet);
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

    const activeElement = audioElements.find(
      (audio) => !audio.paused && !audio.ended && audio.readyState > 0
    );
    if (activeElement) {
      return activeElement;
    }

    const progressElement = audioElements.find(
      (audio) => audio.currentTime > 0 && !audio.ended
    );
    if (progressElement) {
      return progressElement;
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
    const audioElements = getAudioElements();
    return pickMainAudioElement(audioElements);
  }

  function findVolumeRangeInput() {
    const inputElement = findFirstMatchingElement([
      "input[data-testid='volume-bar']",
      "[data-testid='volume-bar'] input[type='range']",
      "input[type='range'][aria-label*='Volume']",
      "input[type='range'][aria-label*='volume']",
    ]);

    return inputElement instanceof HTMLInputElement ? inputElement : null;
  }

  function findVolumeSlider() {
    return findFirstMatchingElement([
      "[data-testid='volume-bar'][role='slider']",
      "[data-testid='volume-bar'] [role='slider']",
      "[role='slider'][aria-label*='Volume']",
      "[role='slider'][aria-label*='volume']",
    ]);
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

  function applyVolumeViaRangeInput(volume) {
    const inputElement = findVolumeRangeInput();
    if (!inputElement) {
      return false;
    }

    const min = Number(inputElement.min);
    const max = Number(inputElement.max);
    const safeMin = Number.isFinite(min) ? min : 0;
    const safeMax = Number.isFinite(max) ? max : 1;
    const targetNumeric = safeMin + volume * (safeMax - safeMin);
    const targetValue = String(targetNumeric);

    setNativeInputValue(inputElement, targetValue);
    inputElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputElement.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const normalizedRange = safeMax - safeMin;
    if (normalizedRange <= 0) {
      return true;
    }

    const currentNumeric = Number(inputElement.value);
    if (!Number.isFinite(currentNumeric)) {
      return true;
    }

    const normalizedCurrent = (currentNumeric - safeMin) / normalizedRange;
    return Math.abs(normalizedCurrent - volume) <= 0.05;
  }

  function applyVolumeViaSliderPointer(volume) {
    const sliderElement = findVolumeSlider();
    if (!sliderElement) {
      return false;
    }

    const rect = sliderElement.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return false;
    }

    const clientX = rect.left + rect.width * volume;
    const clientY = rect.top + rect.height / 2;
    const baseEventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      buttons: 1,
    };

    if (typeof PointerEvent === "function") {
      sliderElement.dispatchEvent(
        new PointerEvent("pointerdown", { ...baseEventOptions, pointerId: 1 })
      );
      sliderElement.dispatchEvent(
        new PointerEvent("pointermove", { ...baseEventOptions, pointerId: 1 })
      );
      sliderElement.dispatchEvent(
        new PointerEvent("pointerup", { ...baseEventOptions, pointerId: 1 })
      );
    }

    sliderElement.dispatchEvent(new MouseEvent("mousedown", baseEventOptions));
    sliderElement.dispatchEvent(new MouseEvent("mousemove", baseEventOptions));
    sliderElement.dispatchEvent(new MouseEvent("mouseup", baseEventOptions));
    sliderElement.dispatchEvent(new MouseEvent("click", baseEventOptions));

    return true;
  }

  function applyVolumeViaUiControl(volume) {
    if (applyVolumeViaRangeInput(volume)) {
      return true;
    }

    return applyVolumeViaSliderPointer(volume);
  }

  function applyVolume(audioElement, volume) {
    try {
      audioElement.volume = volume;
    } catch (error) {
      console.error(
        "[SpotifyDuck] Direct volume control failed while writing to audio.volume.",
        error
      );
      return false;
    }

    if (Math.abs(audioElement.volume - volume) > 0.01) {
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

    observedAudioElement.removeEventListener("play", handleAudioLifecycleEvent);
    observedAudioElement.removeEventListener(
      "loadedmetadata",
      handleAudioLifecycleEvent
    );
    observedAudioElement.removeEventListener(
      "durationchange",
      handleAudioLifecycleEvent
    );
    observedAudioElement = null;
  }

  function observeAudioElement(audioElement) {
    if (observedAudioElement === audioElement) {
      return;
    }

    removeObservedAudioListeners();
    observedAudioElement = audioElement;
    observedAudioElement.addEventListener("play", handleAudioLifecycleEvent);
    observedAudioElement.addEventListener(
      "loadedmetadata",
      handleAudioLifecycleEvent
    );
    observedAudioElement.addEventListener(
      "durationchange",
      handleAudioLifecycleEvent
    );
  }

  function tryApplyDesiredVolume() {
    const audioElement = findMainAudioElement();
    if (audioElement) {
      observeAudioElement(audioElement);
      if (applyVolume(audioElement, desiredVolume)) {
        return true;
      }
    }

    return applyVolumeViaUiControl(desiredVolume);
  }

  function handleAudioLifecycleEvent() {
    scheduleApplyDesiredVolume();
  }

  function scheduleApplyDesiredVolume() {
    if (applyQueued) {
      return;
    }

    applyQueued = true;
    queueMicrotask(() => {
      applyQueued = false;
      void tryApplyDesiredVolume();
    });
  }

  function ensureDomObserver() {
    if (domObserver) {
      return;
    }

    const root = document.documentElement ?? document;
    domObserver = new MutationObserver(() => {
      scheduleApplyDesiredVolume();
    });
    domObserver.observe(root, { childList: true, subtree: true });
  }

  async function setDesiredVolume(volume) {
    desiredVolume = volume;
    ensureDomObserver();
    const appliedImmediately = tryApplyDesiredVolume();
    if (!appliedImmediately) {
      scheduleApplyDesiredVolume();
    }
    return appliedImmediately;
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
      .then((success) => {
        sendResponse({ success });
      })
      .catch((error) => {
        console.error("[SpotifyDuck] Unexpected error while setting volume.", error);
        sendResponse({ success: false });
      });

    return true;
  });
})();
