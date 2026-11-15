import test from "node:test";
import assert from "node:assert/strict";
import { createRouteMap } from "../src/map.js";

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.classList = { add() {} };
    this.textContent = "";
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...elements) {
    this.children.push(...elements);
  }

  replaceChildren(...elements) {
    this.children = [...elements];
  }

  addEventListener(name, handler, options = {}) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push({ handler, once: Boolean(options.once) });
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    const listeners = this.listeners.get(name) ?? [];
    this.listeners.set(name, listeners.filter((listener) => !listener.once));
    for (const listener of listeners) listener.handler();
  }

  remove() {
    this.removed = true;
  }

  getBoundingClientRect() {
    return { width: 640, height: 320 };
  }
}

function withMapDom(callback) {
  const previousGlobals = {
    HTMLElement: globalThis.HTMLElement,
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  globalThis.HTMLElement = MockElement;
  globalThis.document = {
    createElement: (tagName) => new MockElement(tagName),
    createElementNS: (_namespace, tagName) => new MockElement(tagName),
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };

  try {
    callback();
  } finally {
    for (const [name, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

const route = {
  type: "LineString",
  coordinates: [[-84.512, 39.103], [-84.51, 39.08]],
};

test("setting a route draws its tiles and route line without removing map states", () => {
  withMapDom(() => {
    const container = new MockElement("div");
    const loading = new MockElement("p");
    const error = new MockElement("p");
    container.append(loading, error);
    const map = createRouteMap(container);
    map.setRoute(route);

    const [preservedLoading, preservedError, canvas] = container.children;
    const [tiles, routeLayer, status, attribution] = canvas.children;
    const routePath = routeLayer.children[1];
    assert.equal(preservedLoading, loading);
    assert.equal(preservedError, error);
    assert.ok(tiles.children.length > 0);
    assert.match(routePath.getAttribute("d"), /^M.+ L/);
    assert.equal(status.textContent, "Driving route map");
    assert.equal(attribution.id, "map-attribution");
    assert.equal(container.children.length, 3);
  });
});

test("tile failures from a cleared or replaced route cannot overwrite current map status", () => {
  withMapDom(() => {
    const container = new MockElement("div");
    const map = createRouteMap(container);
    const canvas = container.children[0];
    const [tiles, , status] = canvas.children;

    map.setRoute(route);
    const firstRouteTile = tiles.children[0];
    map.clearRoute();
    firstRouteTile.dispatch("error");
    assert.equal(status.textContent, "Add a route to see the map.");

    map.setRoute(route);
    firstRouteTile.dispatch("error");
    assert.equal(status.textContent, "Driving route map");
  });
});
