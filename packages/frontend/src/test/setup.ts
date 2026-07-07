import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock HTMLCanvasElement.getContext since jsdom doesn't implement it
const canvasContextMock = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillStyle: "",
  globalAlpha: 1,
};
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(canvasContextMock) as typeof HTMLCanvasElement.prototype.getContext;

// Mock ResizeObserver since jsdom doesn't implement it. Must be a real class:
// vi.fn().mockImplementation(...) is not constructible under vitest 4, so
// CodeMirror's `new ResizeObserver(...)` throws in EditorView-based tests.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// Provide a functional localStorage backed by a Map
const store = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, value); },
  removeItem: (key) => { store.delete(key); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (index) => [...store.keys()][index] ?? null,
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
