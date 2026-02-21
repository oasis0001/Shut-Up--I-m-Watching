const MODE_STORAGE_KEY = "duckMode";
const MODE_DUCK = "duck";
const MODE_PAUSE = "pause";
const STORAGE_AREA = chrome.storage?.local ?? chrome.storage?.sync;

const lowVolRadio = document.getElementById("low-vol");
const pauseRadio = document.getElementById("pause");
function applyMode(mode) {
  if (mode === MODE_PAUSE) {
    pauseRadio.checked = true;
  } else {
    lowVolRadio.checked = true;
  }
}

function persistMode(mode) {
  STORAGE_AREA?.set({ [MODE_STORAGE_KEY]: mode });
}

lowVolRadio.addEventListener("change", () => {
  if (lowVolRadio.checked) {
    applyMode(MODE_DUCK);
    persistMode(MODE_DUCK);
  }
});

pauseRadio.addEventListener("change", () => {
  if (pauseRadio.checked) {
    applyMode(MODE_PAUSE);
    persistMode(MODE_PAUSE);
  }
});

STORAGE_AREA?.get({ [MODE_STORAGE_KEY]: MODE_DUCK }, (result) => {
  const stored = result?.[MODE_STORAGE_KEY];
  applyMode(stored === MODE_PAUSE ? MODE_PAUSE : MODE_DUCK);
});
