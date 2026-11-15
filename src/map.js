const TILE_SIZE = 256;
const MAX_ZOOM = 20;
const MAX_ROUTE_POINTS = 10_000;
const MAX_MERCATOR_LATITUDE = 85.05112878;

function project(longitude, latitude) {
  const safeLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const latitudeRadians = (safeLatitude * Math.PI) / 180;
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2,
  };
}

function normalizeRoute(route) {
  const geometry = route?.geometry ?? route?.routeGeometry ?? route;
  if (
    geometry?.type !== "LineString" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length < 2 ||
    geometry.coordinates.length > MAX_ROUTE_POINTS
  ) {
    throw new TypeError("The route map needs a valid GeoJSON LineString.");
  }

  const points = geometry.coordinates.map((coordinate) => {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1]) ||
      coordinate[0] < -180 ||
      coordinate[0] > 180 ||
      coordinate[1] < -90 ||
      coordinate[1] > 90
    ) {
      throw new TypeError("The route map received an invalid coordinate.");
    }
    return project(coordinate[0], coordinate[1]);
  });

  for (let index = 1; index < points.length; index += 1) {
    const difference = points[index].x - points[index - 1].x;
    if (difference > 0.5) points[index].x -= 1;
    if (difference < -0.5) points[index].x += 1;
  }
  const routeCenterX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const stops = (Array.isArray(route?.stops) ? route.stops : []).map((stop) => {
    const latitude = Number(stop?.lat ?? stop?.latitude);
    const longitude = Number(stop?.lon ?? stop?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new TypeError("The route map received an invalid stop coordinate.");
    }
    const point = project(longitude, latitude);
    while (point.x - routeCenterX > 0.5) point.x -= 1;
    while (point.x - routeCenterX < -0.5) point.x += 1;
    return point;
  });
  return { points, stops };
}

function makeAttribution() {
  const attribution = document.createElement("p");
  attribution.className = "route-map__attribution";
  attribution.id = "map-attribution";

  const parts = [
    { label: "Powered by Geoapify", href: "https://www.geoapify.com/" },
    { label: "© OpenMapTiles", href: "https://openmaptiles.org/" },
    { label: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
  ];

  parts.forEach((part, index) => {
    if (index > 0) attribution.append(" | ");
    const link = document.createElement("a");
    link.href = part.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = part.label;
    attribution.append(link);
  });
  return attribution;
}

function tilePath(zoom, x, y) {
  const tileCount = 2 ** zoom;
  const wrappedX = ((x % tileCount) + tileCount) % tileCount;
  return `/api/map/${zoom}/${wrappedX}/${y}.png`;
}

/**
 * Draw a route GeoJSON LineString over proxied Geoapify raster tiles.
 * The service attribution remains visible for both the Geoapify free plan and
 * the OpenStreetMap/OpenMapTiles sources used by the selected tile style.
 */
export function createRouteMap(element) {
  if (!(element instanceof HTMLElement)) throw new TypeError("A map container element is required.");

  const canvas = document.createElement("div");
  canvas.className = "route-map__canvas";
  canvas.setAttribute("role", "group");
  canvas.setAttribute("aria-label", "Driving route map");
  Object.assign(canvas.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    minHeight: "220px",
    overflow: "hidden",
    background: "#f2f3ef",
  });

  const tileLayer = document.createElement("div");
  tileLayer.className = "route-map__tiles";
  Object.assign(tileLayer.style, { position: "absolute", inset: "0", overflow: "hidden" });

  const routeLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  routeLayer.classList.add("route-map__route");
  routeLayer.setAttribute("aria-hidden", "true");
  Object.assign(routeLayer.style, { position: "absolute", inset: "0", width: "100%", height: "100%", overflow: "hidden" });

  const halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
  halo.setAttribute("fill", "none");
  halo.setAttribute("stroke", "#ffffff");
  halo.setAttribute("stroke-width", "8");
  halo.setAttribute("stroke-linecap", "round");
  halo.setAttribute("stroke-linejoin", "round");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#123d38");
  path.setAttribute("stroke-width", "4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  const startPoint = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  startPoint.setAttribute("r", "6");
  startPoint.setAttribute("fill", "#ffffff");
  startPoint.setAttribute("stroke", "#123d38");
  startPoint.setAttribute("stroke-width", "3");

  const endPoint = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  endPoint.setAttribute("r", "6");
  endPoint.setAttribute("fill", "#123d38");
  endPoint.setAttribute("stroke", "#ffffff");
  endPoint.setAttribute("stroke-width", "3");

  const stopLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  stopLayer.setAttribute("aria-hidden", "true");

  routeLayer.append(halo, path, startPoint, endPoint, stopLayer);

  const status = document.createElement("p");
  status.className = "route-map__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Add a route to see the map.";
  Object.assign(status.style, {
    position: "absolute",
    top: "0.75rem",
    left: "0.75rem",
    margin: "0",
    padding: "0.4rem 0.6rem",
    background: "rgba(255, 255, 255, 0.94)",
    color: "#23312f",
    font: "inherit",
    zIndex: "1",
  });

  const attribution = makeAttribution();
  Object.assign(attribution.style, {
    position: "absolute",
    right: "0.4rem",
    bottom: "0.4rem",
    margin: "0",
    padding: "0.25rem 0.4rem",
    background: "rgba(255, 255, 255, 0.94)",
    color: "#23312f",
    fontSize: "0.72rem",
    lineHeight: "1.3",
    zIndex: "1",
  });

  canvas.append(tileLayer, routeLayer, status, attribution);
  element.append(canvas);

  let route = null;
  let destroyed = false;
  let resizeObserver = null;
  let renderGeneration = 0;

  function render() {
    if (destroyed || !route) return;
    const generation = ++renderGeneration;
    const bounds = element.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || 640));
    const height = Math.max(1, Math.round(bounds.height || 320));
    const padding = Math.min(44, Math.max(24, Math.round(Math.min(width, height) * 0.12)));

    const boundsPoints = [...route.points, ...route.stops];
    const minX = Math.min(...boundsPoints.map((point) => point.x));
    const maxX = Math.max(...boundsPoints.map((point) => point.x));
    const minY = Math.min(...boundsPoints.map((point) => point.y));
    const maxY = Math.max(...boundsPoints.map((point) => point.y));
    const spanX = Math.max(maxX - minX, 0.00002);
    const spanY = Math.max(maxY - minY, 0.00002);
    const availableWidth = Math.max(64, width - padding * 2);
    const availableHeight = Math.max(64, height - padding * 2);
    const fitScale = Math.min(availableWidth / (spanX * TILE_SIZE), availableHeight / (spanY * TILE_SIZE));
    const zoom = Math.max(2, Math.min(MAX_ZOOM, Math.floor(Math.log2(Math.max(1, fitScale)))));
    const worldScale = 2 ** zoom * TILE_SIZE;
    const centerX = ((minX + maxX) / 2) * worldScale;
    const centerY = ((minY + maxY) / 2) * worldScale;
    const leftWorld = centerX - width / 2;
    const topWorld = centerY - height / 2;
    const firstTileX = Math.floor(leftWorld / TILE_SIZE);
    const lastTileX = Math.floor((centerX + width / 2) / TILE_SIZE);
    const firstTileY = Math.max(0, Math.floor(topWorld / TILE_SIZE));
    const lastTileY = Math.min(2 ** zoom - 1, Math.floor((centerY + height / 2) / TILE_SIZE));

    tileLayer.replaceChildren();
    routeLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);

    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
        const image = document.createElement("img");
        image.className = "route-map__tile";
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        image.loading = "lazy";
        image.decoding = "async";
        image.src = tilePath(zoom, tileX, tileY);
        Object.assign(image.style, {
          position: "absolute",
          width: `${TILE_SIZE}px`,
          height: `${TILE_SIZE}px`,
          maxWidth: "none",
          left: `${tileX * TILE_SIZE - leftWorld}px`,
          top: `${tileY * TILE_SIZE - topWorld}px`,
        });
        image.addEventListener("error", () => {
          if (!destroyed && generation === renderGeneration && route) {
            status.textContent = "Some map tiles could not be loaded. The route is still shown.";
          }
        }, { once: true });
        tileLayer.append(image);
      }
    }

    const screenPoints = route.points.map((point) => ({
      x: point.x * worldScale - leftWorld,
      y: point.y * worldScale - topWorld,
    }));
    const screenStops = route.stops.map((point) => ({
      x: point.x * worldScale - leftWorld,
      y: point.y * worldScale - topWorld,
    }));
    const pathData = screenPoints.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
    halo.setAttribute("d", pathData);
    path.setAttribute("d", pathData);
    startPoint.setAttribute("cx", screenPoints[0].x.toFixed(2));
    startPoint.setAttribute("cy", screenPoints[0].y.toFixed(2));
    const last = screenPoints[screenPoints.length - 1];
    endPoint.setAttribute("cx", last.x.toFixed(2));
    endPoint.setAttribute("cy", last.y.toFixed(2));
    stopLayer.replaceChildren();
    screenStops.forEach((point, index) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      marker.setAttribute("r", "8");
      marker.setAttribute("fill", "#ffffff");
      marker.setAttribute("stroke", "#123d38");
      marker.setAttribute("stroke-width", "2");
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.setAttribute("fill", "#123d38");
      label.setAttribute("font-size", "9");
      label.setAttribute("font-weight", "700");
      label.textContent = String(index + 1);
      group.append(marker, label);
      stopLayer.append(group);
    });
    status.textContent = "Driving route map";
  }

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(element);
  } else {
    window.addEventListener("resize", render);
  }

  return Object.freeze({
    setRoute(nextRoute) {
      if (destroyed) return;
      route = normalizeRoute(nextRoute);
      render();
    },

    clearRoute() {
      if (destroyed) return;
      renderGeneration += 1;
      route = null;
      tileLayer.replaceChildren();
      for (const shape of [halo, path, startPoint, endPoint]) shape.removeAttribute("d");
      startPoint.removeAttribute("cx");
      startPoint.removeAttribute("cy");
      endPoint.removeAttribute("cx");
      endPoint.removeAttribute("cy");
      stopLayer.replaceChildren();
      status.textContent = "Add a route to see the map.";
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderGeneration += 1;
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", render);
      canvas.remove();
    },
  });
}
