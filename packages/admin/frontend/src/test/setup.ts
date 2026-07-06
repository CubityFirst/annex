import "@testing-library/jest-dom";

// Functional local/sessionStorage backed by Maps (jsdom's built-ins work,
// but tests want a clean, controllable store per file).
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
  };
}
Object.defineProperty(window, "localStorage", { value: makeStorage(), writable: true });
Object.defineProperty(window, "sessionStorage", { value: makeStorage(), writable: true });
