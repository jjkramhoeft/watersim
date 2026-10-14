// Tiny observable settings store with optional localStorage persistence.
const STORAGE_KEY = 'watersim.settings.v1';

export class Store {
  constructor(defaults, persistKeys = []) {
    this.defaults = defaults;
    this.persistKeys = new Set(persistKeys);
    this.state = { ...defaults };
    this.listeners = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const k of this.persistKeys) {
        if (k in saved && typeof saved[k] === typeof defaults[k]) this.state[k] = saved[k];
      }
    } catch {
      /* storage unavailable */
    }
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    for (const fn of this.listeners) fn(key, value);
    if (this.persistKeys.has(key)) this._save();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _save() {
    try {
      const out = {};
      for (const k of this.persistKeys) out[k] = this.state[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable */
    }
  }
}
