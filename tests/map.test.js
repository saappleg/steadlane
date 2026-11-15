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

  addEventListener() {}

  remove() {
    this.removed = true;
  }

  getBoundingClientRect() {
    return { width: 640, height: 320 };
  }
}

test("setting a route draws its tiles and route line", () => {
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
    const container = new MockElement("div");
    const map = createRouteMap(container);
    map.setRoute({
      type: "LineString",
      coordinates: [[-84.512, 39.103], [-84.51, 39.08]],
    });

    const canvas = container.children[0];
    const [tiles, routeLayer, status] = canvas.children;
    const routePath = routeLayer.children[1];
    assert.ok(tiles.children.length > 0);
    assert.match(routePath.getAttribute("d"), /^M.+ L/);
    assert.equal(status.textContent, "Driving route map");
  } finally {
    for (const [name, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
