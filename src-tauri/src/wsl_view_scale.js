const storageKey = 'mymind.wsl.view-scale';
const minPercent = 100;
const maxPercent = 200;
const step = 25;
let percent = defaultPercent;
let pending = Promise.resolve();

function setScale(next) {
  percent = Math.max(minPercent, Math.min(maxPercent, next));
  const value = percent;
  pending = pending.then(async () => {
    await window.__TAURI_INTERNALS__.invoke('planner_request', {
      operation: 'setWslViewScale',
      input: value,
    });
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // The view can still resize when local storage is unavailable.
    }
  }).catch(error => console.error('Could not resize MYMIND', error));
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved >= minPercent && saved <= maxPercent && saved % step === 0) {
      setScale(saved);
    }
  } catch {
    // The native default is already applied.
  }
}, { once: true });

window.addEventListener('keydown', event => {
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  let next;
  switch (event.key) {
    case '+':
    case '=': next = percent + step; break;
    case '-': next = percent - step; break;
    case '0': next = defaultPercent; break;
    default: return;
  }
  event.preventDefault();
  setScale(next);
});
