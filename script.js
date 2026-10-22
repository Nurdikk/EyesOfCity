"use strict";

// City Eyes 3.0 — live OpenStreetMap places with a local cache and labeled demo fallback.
// Routes are planning previews, not verified accessible or safe navigation.
const $ = (selector) => document.querySelector(selector);
const ALMATY = [43.237097, 76.931424];
const PAGE_SIZE = 24;
const MAP_MARKER_LIMIT = 180;
const CACHE_KEY = "city-eyes-osm-places-v3";
const SEARCH_RADIUS_METERS = 8000;
const CATEGORIES = {
  all: "All places", pharmacy: "Pharmacies", clinic: "Clinics",
  service: "Public service centers", transport: "Bus stops"
};
const ICONS = { pharmacy: "✚", clinic: "♡", service: "▤", transport: "▣" };
const ui = {
  grid: $("#placesGrid"), count: $("#resultCount"), search: $("#searchInput"),
  status: $("#dataStatus"), sr: $("#screenReaderOutput"), voice: $("#commandStatus"),
  mic: $("#micBtn"), settings: $("#settingsDialog"), info: $("#infoDialog")
};
let locations = [];
let activeCategory = "all";
let searchTerm = "";
let map = null;
let markers = null;
let selectedPlace = null;
let currentRecognition = null;
let listenStarted = false;
let locationMarker = null;
let fetchController = null;
let taggedAccessOnly = false;
let routeLine = null;
let routePoints = null;
let routeRequest = null;
let routeSequence = 0;
let routeDirections = [];
let routeStepIndex = 0;
let routeDestination = null;
let visibleCount = PAGE_SIZE;
let dataState = "loading";
let dataGeneration = 0;
let voiceFeedback = "Ready";
let datasetSource = "local";
let userPosition = null;
// Curated presentation dataset. Building-level coordinates; entrances may differ.
const localPlaces = [
  { id: "local/biosfera", kind: "pharmacy", name: "Biosfera Pharmacy", address: "27 Satpayev Street, Almaty", lat: 43.237524, lon: 76.929224 },
  { id: "local/anc-koktem", kind: "pharmacy", name: "ANC Low Price Pharmacy", address: "16 Koktem-1 microdistrict, Almaty", lat: 43.228762, lon: 76.924724 },
  { id: "local/koktem-pharmacy", kind: "pharmacy", name: "Pharmacy — Koktem-1", address: "20 Koktem-1 microdistrict, Almaty", lat: 43.229471, lon: 76.923733 },
  { id: "local/student-clinic", kind: "clinic", name: "Satbayev University Student Polyclinic", address: "Dormitory No. 1, 22B Satpayev Street, Almaty", lat: 43.236908, lon: 76.934838 },
  { id: "local/university-medical", kind: "clinic", name: "Satbayev University Medical Center", address: "Main Academic Building, Room 204, 22 Satpayev Street, Almaty", lat: 43.237097, lon: 76.931424 }
].map((entry) => ({
  ...entry, isDemo: false, isLocal: true, hours: "Confirm opening hours before visiting",
  accessibility: "Accessibility information has not been verified",
  accessTags: { "Wheelchair access": null, "Entrance wheelchair access": null,
    "Tactile paving": null, "Audible signals": null, "Accessible toilet": null },
  osmUrl: `https://www.openstreetmap.org/?mlat=${entry.lat}&mlon=${entry.lon}#map=18/${entry.lat}/${entry.lon}`
}));


function announce(message) {
  ui.sr.textContent = "";
  window.setTimeout(() => { ui.sr.textContent = message; }, 40);
}
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* Optional */ } }
function savedPlaces() {
  try {
    const data = JSON.parse(storageGet(CACHE_KEY));
    if (!Array.isArray(data?.places) || !data.places.length) return null;
    const places = data.places.filter((p) => p && /^((node|way|relation)\/\d+)$/.test(p.id)
      && CATEGORIES[p.kind] && Number.isFinite(p.lat) && Number.isFinite(p.lon)
      && typeof p.name === "string" && p.accessTags && typeof p.accessTags === "object"
      && typeof p.osmUrl === "string");
    if (!places.length) return null;
    return { places, savedAt: data.savedAt || null };
  } catch { return null; }
}
function savePlaces(places) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), places })); }
  catch { /* Private mode or storage full: still use live places */ }
}
function chooseInitialPlaces() {
  locations = localPlaces;
  datasetSource = "local";
  dataState = "ready";
}
function datasetNotice() {
  return "UNIVERSITY DEMO: Five curated real-world destinations near Satbayev University. Approximate building coordinates; check entrances and accessibility on site. No places API required.";
}
function feedback(message, speak = false) {
  $("#commandFeedback").textContent = message;
  ui.voice.textContent = message;
  if (speak) say(message);
  else announce(message);
}

function say(message) {
  if (!("speechSynthesis" in window)) { announce("Text-to-speech is unavailable in this browser."); return; }
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(message);
  speech.lang = "en-US";
  speech.rate = 0.92;
  window.speechSynthesis.speak(speech);
}
function setContrast(enabled, notify = false) {
  document.body.classList.toggle("high-contrast", enabled);
  $("#contrastBtn").setAttribute("aria-checked", String(enabled));
  storageSet("city-eyes-contrast", enabled ? "1" : "0");
  if (notify) announce(enabled ? "High contrast enabled." : "High contrast disabled.");
}
function setFontSize(value, notify = false) {
  const n = Number(value);
  const size = Number.isFinite(n) ? Math.min(140, Math.max(100, Math.round(n / 10) * 10)) : 100;
  document.documentElement.style.setProperty("--font-scale", String(size / 100));
  $("#fontSizeRange").value = String(size);
  $("#fontSizeValue").textContent = `${size}%`;
  storageSet("city-eyes-font-size", size);
  if (notify) announce(`Text size: ${size} percent.`);
}
function classify(tags) {
  if (tags.amenity === "pharmacy" || tags.shop === "chemist") return "pharmacy";
  if (["clinic", "doctors", "hospital"].includes(tags.amenity) || tags.healthcare === "clinic") return "clinic";
  if (["government", "public_service"].includes(tags.office) || tags.amenity === "public_service") return "service";
  if (tags.highway === "bus_stop" || tags.public_transport === "platform" && tags.bus === "yes") return "transport";
  return null;
}
function addressOf(tags) {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  return [street, tags["addr:city"]].filter(Boolean).join(", ") || "Address not provided";
}
function normalizedLocation(item) {
  const kind = classify(item.tags || {});
  const latitude = item.lat ?? item.center?.lat;
  const longitude = item.lon ?? item.center?.lon;
  if (!kind || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const tags = item.tags || {};
  return {
    id: `${item.type}/${item.id}`, kind, lat: latitude, lon: longitude, isDemo: false,
    name: tags["name:en"] || tags.name || `${({ pharmacy: "Pharmacy", clinic: "Clinic", service: "Public service center", transport: "Bus stop" })[kind]} (unnamed)`,
    address: addressOf(tags),
    hours: tags.opening_hours || "Not listed",
    accessibility: tags.wheelchair === "yes" ? "Wheelchair access tagged: yes" : tags.wheelchair === "no" ? "Wheelchair access tagged: no" : tags.wheelchair === "limited" ? "Wheelchair access tagged: limited" : "Wheelchair accessibility not specified",
    accessTags: {
      "Wheelchair access": tags.wheelchair,
      "Entrance wheelchair access": tags["entrance:wheelchair"],
      "Tactile paving": tags.tactile_paving,
      "Audible signals": tags.traffic_signals === "sound" ? "yes" : tags["traffic_signals:sound"],
      "Accessible toilet": tags["toilets:wheelchair"]
    },
    osmUrl: `https://www.openstreetmap.org/${item.type}/${item.id}`
  };
}
function mapStatus(message) { ui.status.textContent = message; }
function createMap() {
  if (!window.L) {
    $("#mapFallback").hidden = false;
    mapStatus("Map tiles unavailable. Text results may still load.");
    return;
  }
  map = L.map("cityMap", { scrollWheelZoom: false }).setView(ALMATY, 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>', maxZoom: 19
  }).addTo(map);
  markers = L.layerGroup().addTo(map);
}
function matchesQuery(place) {
  const text = `${place.name} ${place.address} ${CATEGORIES[place.kind]}`.toLocaleLowerCase("en");
  return (activeCategory === "all" || place.kind === activeCategory) && (!taggedAccessOnly || place.accessTags["Wheelchair access"] === "yes") && text.includes(searchTerm.toLocaleLowerCase("en"));
}
function detailsText(place) {
  if (place.isDemo) return `${place.name}. This is a fictional demonstration card and is not a real destination.`;
  return `${place.name}. ${CATEGORIES[place.kind]}. ${place.address}. Opening hours: ${place.hours}. ${place.accessibility}. Check information before travelling.`;
}
function accessStatus(value) {
  const entry = typeof value === "string" ? value.toLowerCase() : "";
  if (["yes", "designated"].includes(entry)) return { text: "Reported accessible / available", className: "access-yes" };
  if (entry === "no") return { text: "Reported not accessible / unavailable", className: "access-no" };
  if (entry === "limited") return { text: "Reported limited access", className: "access-limited" };
  return { text: "Not specified", className: "access-unknown" };
}
function showDetails(place) {
  selectedPlace = place;
  $("#infoTitle").textContent = place.name;
  $("#infoDescription").textContent = `${CATEGORIES[place.kind]}. ${place.address}. Opening hours: ${place.hours}.`;
  const list = $("#accessibilityList"); list.replaceChildren();
  for (const [feature, value] of Object.entries(place.accessTags)) {
    const row = document.createElement("div"); row.className = "access-row";
    const term = document.createElement("dt"); term.textContent = feature;
    const detail = document.createElement("dd");
    const status = accessStatus(value);
    detail.textContent = status.text; detail.className = status.className;
    if (value && !["yes","no","limited","designated"].includes(String(value).toLowerCase())) {
      detail.textContent = `Map tag: ${String(value).slice(0,80)} (interpret with caution)`;
    }
    row.append(term, detail); list.append(row);
  }
  $("#accessSource").textContent = place.isDemo
    ? "DEMO ONLY: This example is fictional. No real location, address or access information exists."
    : place.isLocal ? "Source: curated university demonstration locations. Approximate building positions; accessibility unverified." : `Source: OpenStreetMap ${place.id}; community-maintained information, not independently verified.`;
  $("#issueMessage").value = ""; $("#issueType").selectedIndex = 0; $("#reportStatus").textContent = "";
  $("#openOsmLink").hidden = Boolean(place.isDemo);
  if (!place.isDemo) $("#openOsmLink").href = place.osmUrl;
  $("#planInfoBtn").disabled = Boolean(place.isDemo);
  const fallback = $("#reportFallback"); if (fallback) fallback.remove();
  if (!ui.info.open) ui.info.showModal();
}
async function copyIssueReport() {
  if (!selectedPlace || selectedPlace.isDemo) { $("#reportStatus").textContent = "Issue reporting is unavailable for fictional demo cards."; return; }
  const feature = $("#issueType").value;
  const description = $("#issueMessage").value.trim();
  const report = `City Eyes accessibility feedback\nPlace: ${selectedPlace.name}\nOSM: ${selectedPlace.osmUrl}\nFeature to check: ${feature}\nDetails: ${description || "Not provided"}\nPlease verify on site before updating map data.`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard not supported");
    await navigator.clipboard.writeText(report);
    $("#reportStatus").textContent = "Issue report copied. It has not been submitted.";
    const fallback = $("#reportFallback"); if (fallback) fallback.remove();
  } catch {
    $("#reportStatus").textContent = "Automatic copying is unavailable. Select and copy the report from the text below.";
    let box = $("#reportFallback");
    if (!box) { box = document.createElement("textarea"); box.id = "reportFallback"; box.readOnly = true; box.rows = 5; $("#reportStatus").after(box); }
    box.value = report; box.focus(); box.select();
  }
}

function mapFocus(place) {
  if (place.isDemo) { announce("This is a fictional demo place without map coordinates."); return; }
  if (!map) { announce("Map unavailable. Place information is available in the list."); return; }
  map.setView([place.lat, place.lon], 16);
  for (const marker of markers.getLayers()) {
    if (marker.cityEyesId === place.id) { marker.openPopup(); break; }
  }
  $("#cityMap").focus({ preventScroll: true });
  announce(`Map centered on ${place.name}.`);
}
function makeButton(label, ariaLabel, callback) {
  const button = document.createElement("button");
  button.className = "card-action";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", callback);
  return button;
}
function render() {
  const matched = locations.filter(matchesQuery);
  const filtered = matched.slice(0, visibleCount);
  const grid = ui.grid;
  grid.replaceChildren();
  grid.setAttribute("aria-busy", String(dataState === "loading"));
  if (markers) markers.clearLayers();
  const fragment = document.createDocumentFragment();
  for (const place of filtered) {
    const card = document.createElement("article");
    card.className = "place-card";
    card.dataset.placeId = place.id;
    const icon = document.createElement("span");
    icon.className = "place-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = ICONS[place.kind];
    const title = document.createElement("h4");
    title.textContent = place.name;
    const category = document.createElement("p");
    category.textContent = CATEGORIES[place.kind];
    const addr = document.createElement("p");
    addr.className = "place-meta";
    addr.textContent = place.address;
    const access = document.createElement("p");
    access.className = "access-preview";
    access.textContent = place.isDemo ? "Fictional example — not a real location" :
      `Wheelchair access: ${accessStatus(place.accessTags["Wheelchair access"]).text.toLowerCase()}`;
    const actions = document.createElement("div");
    actions.className = "place-card-actions";
    actions.append(makeButton("Place details →", `Details for ${place.name}`, () => showDetails(place)));
    if (!place.isDemo) {
      const mapButton = makeButton("View on map ↗", `Show ${place.name} on map`, () => mapFocus(place));
      mapButton.disabled = !map;
      const routeButton = makeButton("Plan route ↗", `Plan a walking route to ${place.name}`, () => planRoute(place));
      actions.append(mapButton, routeButton);
    }
    card.append(icon, title, category, addr, access, actions);
    fragment.append(card);
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const heading = document.createElement("strong");
    heading.textContent = dataState === "loading" ? "Loading locations…" : "No matching places";
    const paragraph = document.createElement("p");
    paragraph.textContent = dataState === "loading" ? "Results will appear when loading finishes." :
      "Try another search, clear the accessibility filter, or select All places.";
    empty.append(heading, paragraph);
    fragment.append(empty);
  }
  grid.append(fragment);
  // Map points are independent of the paginated text cards.
  if (markers && map) {
    for (const place of matched.filter((p) => !p.isDemo).slice(0, MAP_MARKER_LIMIT)) {
      const marker = L.marker([place.lat, place.lon]);
      marker.cityEyesId = place.id;
      const popup = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = place.name;
      const addr = document.createElement("p");
      addr.textContent = place.address;
      const plan = document.createElement("button");
      plan.type = "button";
      plan.className = "popup-route";
      plan.textContent = "Plan route";
      plan.addEventListener("click", () => planRoute(place));
      popup.append(strong, addr, plan);
      marker.bindPopup(popup);
      marker.addTo(markers);
    }
  }
  ui.count.textContent = `${datasetSource === "demo" ? "Demo: " : ""}Showing ${filtered.length} of ${matched.length} matching places`;
  const loadMore = $("#loadMoreBtn");
  loadMore.hidden = matched.length <= filtered.length;
  loadMore.textContent = `Show more places (${matched.length - filtered.length} remaining)`;
  $("#clearSearchBtn").hidden = !ui.search.value;
}


function selectCategory(kind, spoken = false) {
  if (!(kind in CATEGORIES)) return;
  activeCategory = kind;
  visibleCount = PAGE_SIZE;
  document.querySelectorAll("[data-category]").forEach((button) => {
    const selected = button.dataset.category === kind;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  render();
  announce(`${CATEGORIES[kind]}. ${ui.count.textContent}.`);
  if (spoken) say(`${CATEGORIES[kind]}. ${ui.count.textContent}.`);
}
function locationQuery() {
  const lat = ALMATY[0], lon = ALMATY[1], r = SEARCH_RADIUS_METERS;
  return `[out:json][timeout:25];(
    nwr(around:${r},${lat},${lon})[amenity=pharmacy];
    nwr(around:${r},${lat},${lon})[shop=chemist];
    nwr(around:${r},${lat},${lon})[amenity~"^(clinic|doctors|hospital)$"];
    nwr(around:${r},${lat},${lon})[healthcare=clinic];
    nwr(around:${r},${lat},${lon})[office~"^(government|public_service)$"];
    nwr(around:${r},${lat},${lon})[amenity=public_service];
    node(around:${r},${lat},${lon})[highway=bus_stop];
  );out center 1800;`;
}
async function tryOverpass(endpoint, query, parentSignal) {
  const attempt = new AbortController();
  const abort = () => attempt.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => attempt.abort(), 14500);
  try {
    let response;
    try {
      response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: attempt.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt.signal.aborted) throw error;
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
        signal: attempt.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    if (!Array.isArray(json?.elements) || json.elements.length === 0) throw new Error("Empty or invalid response");
    return json.elements;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}
async function loadLocations() {
  chooseInitialPlaces();
  mapStatus(`Loaded ${locations.length} curated places near Satbayev University. ${datasetNotice()}`);
  render();
  announce(`Loaded ${locations.length} curated places.`);
}
function mapStatusText() { return ui.status.textContent; }


function useLocation() {
  if (!navigator.geolocation || !window.isSecureContext) { mapStatus("Location requires HTTPS or localhost and a browser with geolocation support."); announce("Location requires HTTPS or localhost."); return; }
  mapStatus("Requesting location permission…");
  $("#locateBtn").disabled = true;
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    if (map) {
      if (locationMarker) map.removeLayer(locationMarker);
      locationMarker = L.circleMarker([coords.latitude, coords.longitude], { radius: 10, color: "#0b223b", fillColor: "#a5e2d2", fillOpacity: 1 }).addTo(map);
      locationMarker.bindPopup("Your approximate location");
      map.setView([coords.latitude, coords.longitude], 14);
    }
    userPosition = [coords.latitude, coords.longitude];
    mapStatus("Your location is shown on the map. Use a nearest-place command to search by distance among currently loaded results.");
    announce("Location found. Map centered on your position.");
    $("#locateBtn").disabled = false;
  }, () => {
    mapStatus("Location unavailable or permission denied. You can still explore the map.");
    announce("Your location could not be determined.");
    $("#locateBtn").disabled = false;
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}
// The public FOSSGIS foot routing demo is for light, non-commercial educational use.
// OSRM's "driving" URL segment is required even on their dedicated routed-foot endpoint.
function routeStatus(message) { $("#routeStatus").textContent = message; announce(message); }
function eraseRoute(cancel = true) {
  routeSequence++;
  if (cancel && routeRequest) routeRequest.abort();
  routeRequest = null;
  routeDirections = []; routeStepIndex = 0;
  if (routeLine && map) map.removeLayer(routeLine);
  if (routePoints && map) map.removeLayer(routePoints);
  routeLine = null; routePoints = null;
  $("#routeResults").hidden = true;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
function instruction(step) {
  const m = step.maneuver || {};
  const modifier = m.modifier || "";
  const road = step.name ? ` onto ${step.name}` : "";
  const direction = {
    "slight left": "slightly left", "slight right": "slightly right",
    "sharp left": "sharply left", "sharp right": "sharply right",
    straight: "straight", left: "left", right: "right", uturn: "around"
  }[modifier] || "ahead";
  let action;
  switch (m.type) {
    case "depart": action = `Start walking${road}`; break;
    case "arrive": action = "You have reached the destination"; break;
    case "turn": action = `Turn ${direction}${road}`; break;
    case "continue": action = `Continue ${direction}${road}`; break;
    case "new name": action = `Continue${road}`; break;
    case "roundabout": case "rotary": action = `Enter the roundabout${m.exit ? ` and take exit ${m.exit}` : ""}${road}`; break;
    case "fork": action = `Keep ${direction}${road}`; break;
    case "end of road": action = `At the end of the road, turn ${direction}${road}`; break;
    case "merge": action = `Merge ${direction}${road}`; break;
    default: action = `Proceed ${direction}${road}`;
  }
  const distance = Number(step.distance);
  return `${action}${Number.isFinite(distance) && distance >= 1 && m.type !== "arrive" ? ` for ${formatDistance(distance)}` : ""}.`;
}
function getCurrentPosition() {
  if (!navigator.geolocation || !window.isSecureContext) {
    return Promise.reject(new Error("Location requires HTTPS or localhost and browser location support. Choose Satbayev University instead."));
  }
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => { userPosition = [coords.latitude, coords.longitude]; resolve(userPosition); },
    () => reject(new Error("Location permission was denied or your position was unavailable. Choose Satbayev University instead.")),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
  ));
}
async function planRoute(place, providedOrigin = null) {
  if (!place || place.isDemo || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
    feedback("Cannot route to fictional demo cards. Load real mapped places first.", true);
    return;
  }
  eraseRoute();
  const sequence = routeSequence;
  routeDestination = place;
  $("#routeDestination").textContent = `${place.name} — ${place.address}`;
  $("#route-planner").scrollIntoView({ behavior: "auto", block: "start" });
  routeStatus("Preparing route…");
  $("#routeTitle").setAttribute("tabindex", "-1");
  $("#routeTitle").focus({ preventScroll: true });
  const fromGPS = $("#routeStart").value === "gps";
  let origin;
  try { origin = providedOrigin || (fromGPS ? await getCurrentPosition() : ALMATY); }
  catch (error) { if (sequence === routeSequence) routeStatus(error.message); return; }
  if (sequence !== routeSequence) return;
  if (Math.hypot(origin[0] - place.lat, origin[1] - place.lon) > 0.5) {
    routeStatus("The starting point is too far from this local planning area. No request was sent."); return;
  }
  const controller = new AbortController(); routeRequest = controller;
  routeStatus("Requesting a pedestrian route from the public routing service…");
  const path = `${origin[1]},${origin[0]};${place.lon},${place.lat}`;
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true`;
  try {
    const routeTimeout = window.setTimeout(() => controller.abort(), 20000);
    let response;
    try { response = await fetch(url, { signal: controller.signal }); } finally { window.clearTimeout(routeTimeout); }
    if (!response.ok) throw new Error(`Routing service returned HTTP ${response.status}.`);
    const data = await response.json();
    if (data.code !== "Ok" || !data.routes?.length) throw new Error("No pedestrian route was found for these coordinates.");
    const result = data.routes[0];
    if (!result.geometry || !Array.isArray(result.geometry.coordinates) || !Array.isArray(result.legs)) throw new Error("Routing data is incomplete.");
    if (sequence !== routeSequence) return;
    const steps = result.legs.flatMap(leg => leg.steps || []);
    routeDirections = steps.slice(0, 250).map(instruction);
    if (!routeDirections.length) routeDirections = ["The service did not return turn-by-turn directions."];
    routeStepIndex = 0;
    const list = $("#routeSteps"); list.replaceChildren();
    for (const direction of routeDirections) {
      const li = document.createElement("li"); li.textContent = direction; list.append(li);
    }
    $("#routeSummary").textContent = `${formatDistance(result.distance)} · About ${Math.max(1, Math.round(result.duration / 60))} min on foot (estimate) · ${fromGPS ? "Your approximate location" : "Satbayev University demonstration start"} → ${place.name}`;
    $("#routeResults").hidden = false;
    if (map) {
      routeLine = L.geoJSON(result.geometry, { style: { color: "#135fce", weight: 7, opacity: 0.9 } }).addTo(map);
      routePoints = L.layerGroup([
        L.circleMarker(origin, { radius: 8, color: "#092538", fillColor: "#a5e2d2", fillOpacity: 1 }),
        L.circleMarker([place.lat, place.lon], { radius: 8, color: "#092538", fillColor: "#ffd166", fillOpacity: 1 })
      ]).addTo(map);
      if (routeLine.getBounds().isValid()) map.fitBounds(routeLine.getBounds(), { padding: [35, 35] });
    }
    routeStatus("Walking route created. Review the steps below. This is not verified accessible or safe navigation.");
    feedback(`A walking route to ${place.name} is ready. The route is not verified for accessibility or safety.`, true);
  } catch (error) {
    if (sequence !== routeSequence) return;
    if (error.name === "AbortError") { routeStatus("Routing took too long or was interrupted. Please select Plan route to retry."); return; }
    routeStatus(`Could not build the route. ${error.message} Try again later or choose another location.`);
  } finally {
    if (routeRequest === controller) routeRequest = null;
  }
}
function readRoute(all) {
  if (!routeDirections.length) return;
  if (all) {
    say(`Walking route to ${routeDestination.name}. ${$("#routeSummary").textContent}. ${routeDirections.join(" ")} This route is not verified for accessibility or safety.`);
  } else {
    if (routeStepIndex >= routeDirections.length) {
      say("End of the route instructions. Use Read directions aloud to review the complete route.");
      return;
    }
    say(`Step ${routeStepIndex + 1} of ${routeDirections.length}. ${routeDirections[routeStepIndex]}`);
    routeStepIndex += 1;
  }
}
$("#routeStart").addEventListener("change", () => {
  eraseRoute();
  routeStatus("Starting point changed. Select Plan route on a place card to calculate again.");
});
$("#readRouteBtn").addEventListener("click", () => readRoute(true));
$("#nextStepBtn").addEventListener("click", () => readRoute(false));
$("#stopReadingBtn").addEventListener("click", () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); });
$("#clearRouteBtn").addEventListener("click", () => {
  eraseRoute(); routeDestination = null;
  $("#routeDestination").textContent = "No destination selected";
  routeStatus("Route cleared. Choose a place to plan another route.");
});

function voiceState(active, message) {
  listenStarted = active;
  ui.mic.classList.toggle("is-listening", active);
  ui.mic.setAttribute("aria-pressed", String(active));
  ui.mic.setAttribute("aria-label", active ? "Stop voice search" : "Start voice search");
  voiceFeedback = message;
  ui.voice.textContent = message;
}
function placeCategory(command) {
  const matches = [
    [/pharmac|chemist|medicine/, "pharmacy"],
    [/clinic|hospital|doctor|medical/, "clinic"],
    [/public service|government|service cent(?:er|re)|documents|\bcon\b|\btson\b|\bцон\b/, "service"],
    [/bus|transport|stop/, "transport"]
  ];
  return matches.find(([pattern]) => pattern.test(command))?.[1] || null;
}
function distanceMeters(one, two) {
  const rad = Math.PI / 180;
  const dLat = (two[0] - one[0]) * rad;
  const dLon = (two[1] - one[1]) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(one[0] * rad) * Math.cos(two[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function nearestPlace(candidates, origin) {
  return [...candidates].sort((a, b) =>
    distanceMeters(origin, [a.lat, a.lon]) - distanceMeters(origin, [b.lat, b.lon]))[0];
}
function findNamedPlace(command, kind = null) {
  const eligible = locations.filter((place) => !place.isDemo && (!kind || place.kind === kind) && (!taggedAccessOnly || place.accessTags["Wheelchair access"] === "yes"));
  const normalized = command.toLocaleLowerCase("en").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Prefer the complete mapped name instead of a fuzzy match to another place.
  const exact = eligible.filter((place) => normalized.includes(place.name.toLocaleLowerCase("en")))
    .sort((a, b) => b.name.length - a.name.length);
  if (exact.length) return exact[0];
  const ignored = new Set(["a", "an", "the", "please", "i", "you", "how", "can", "could", "would", "do", "want", "need", "like", "is", "on", "of", "and", "with", "from", "find", "search", "show", "me", "go", "to", "for", "take", "navigate", "navigation", "build", "make", "plan", "create", "give", "get", "walking", "walk", "route", "directions", "way", "nearest", "closest", "nearby", "near", "in", "at", "around", "almaty", "my", "pharmacy", "pharmacies", "chemist", "clinic", "clinics", "hospital", "hospitals", "doctor", "medical", "public", "service", "center", "centre", "services", "government", "bus", "stop", "stops", "transport"]);
  const terms = normalized.split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
  if (!terms.length) return null;
  const candidates = eligible.filter((place) => terms.every((term) => place.name.toLocaleLowerCase("en").includes(term)));
  // An ambiguous partial name must never silently choose a random destination.
  return candidates.length === 1 ? candidates[0] : null;
}

async function findByVoice(command, wantsRoute) {
  const kind = placeCategory(command);
  const nearest = /nearest|closest|nearby/.test(command) || wantsRoute;
    const candidates = locations.filter((place) => !place.isDemo && (!kind || place.kind === kind) && (!taggedAccessOnly || place.accessTags["Wheelchair access"] === "yes"));
  const genericWords = new Set(["please", "a", "an", "the", "to", "for", "me", "i", "you", "how", "can", "could", "would", "do", "want", "need", "like", "is", "on", "of", "and", "with", "from", "give", "get", "show", "find", "search", "navigate", "navigation", "build", "make", "plan", "walking", "walk", "route", "directions", "way", "nearest", "closest", "nearby", "near", "my", "in", "at", "around", "almaty", "pharmacy", "pharmacies", "chemist", "clinic", "clinics", "hospital", "hospitals", "doctor", "medical", "public", "service", "center", "centre", "services", "government", "bus", "stop", "stops", "transport"]);
  const specificWords = command.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word && !genericWords.has(word));
  const named = !kind || specificWords.length ? findNamedPlace(command, kind) : null;
  if (kind && specificWords.length && !named) {
    feedback("I couldn't find that specific place in the loaded results. Try the exact place name or request the nearest place in the category.", true);
    return;
  }
  if (!kind && !named && wantsRoute && routeDestination && !/to|for|nearest|closest/.test(command)) {
    await planRoute(routeDestination);
    return;
  }
  if (!kind && !named && wantsRoute) {
    feedback("Please name a destination. For example: build a route to the nearest pharmacy.", true);
    return;
  }
  if (!kind && !named) {
    const term = command.replace(/^(?:please )?(?:find|search for|show me)\s+/, "").trim();
    ui.search.value = term;
    searchTerm = term;
    selectCategory("all");
    feedback(`${ui.count.textContent} for ${term}.`, true);
    $("#explore").scrollIntoView({ behavior: "auto" });
    return;
  }
  if (kind) {
    ui.search.value = "";
    searchTerm = "";
    selectCategory(kind);
  }
  if ((kind && !candidates.length) || (named && named.isDemo)) {
    feedback(`No mapped ${kind ? CATEGORIES[kind].toLowerCase() : "place"} found in the current area.`, true);
    return;
  }
  let origin = ALMATY;
  const fromGPS = $("#routeStart").value === "gps";
  if (nearest && fromGPS) {
    try { origin = await getCurrentPosition(); }
    catch (error) {
      feedback(`${error.message} You can choose Satbayev University (demo start) in the route planner.`, true);
      return;
    }
  }
  const chosen = named || nearestPlace(candidates, origin);
  if (!chosen) {
    feedback("No suitable destination was found in the current map data.", true);
    return;
  }
  if (wantsRoute) {
    feedback(`Finding a pedestrian route to ${chosen.name}. ${fromGPS ? "Using your location." : "Using Satbayev University as a demonstration starting point."}`, true);
    await planRoute(chosen, origin);
  } else if (nearest) {
    feedback(`Nearest result ${fromGPS ? "to your location" : "to Satbayev University"} in our loaded data: ${chosen.name}. ${chosen.address}.`, true);
    showDetails(chosen);
  } else {
    feedback(`${CATEGORIES[kind]}. ${ui.count.textContent}.`, true);
    $("#explore").scrollIntoView({ behavior: "auto" });
  }
}
async function voiceCommand(raw) {
  const command = raw.toLocaleLowerCase("en").replace(/[.,!?]+$/g, "").trim();
  if (!command) { feedback("Please say or type a command.", true); return; }
  const wantsRoute = /\b(route|navigate|navigation|directions|way to|how (?:do|can) i get|take me to|go to)\b/.test(command)
    && !/^(?:read|speak|hear|repeat|next|stop|clear)\b/.test(command);
  if (/contrast/.test(command)) {
    const enabled = !/off|disable|normal/.test(command);
    setContrast(enabled, true); feedback(enabled ? "High contrast enabled." : "High contrast disabled.", true); return;
  }
  if (/bigger text|larger text|increase font|increase text/.test(command)) {
    setFontSize(Number($("#fontSizeRange").value) + 10, true); feedback(`Text size ${$("#fontSizeValue").textContent}.`, true); return;
  }
  if (/normal text|reset font/.test(command)) { setFontSize(100, true); feedback("Text size reset.", true); return; }
  if (/smaller text|decrease font|decrease text/.test(command)) {
    setFontSize(Number($("#fontSizeRange").value) - 10, true); feedback(`Text size ${$("#fontSizeValue").textContent}.`, true); return;
  }
  if (/read (the )?route|route directions|speak (the )?route/.test(command)) {
    if (routeDirections.length) readRoute(true);
    else feedback("No route is ready yet. Try: build a route to the nearest pharmacy.", true);
    return;
  }
  if (/^(?:stop|pause|cancel|silence|mute)(?:\s+(?:reading|speaking|speech|voice|directions))?$/.test(command)) {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    feedback("Speech playback stopped.");
    return;
  }
  if (/next step/.test(command)) {
    if (routeDirections.length) readRoute(false);
    else feedback("No route steps available yet.", true);
    return;
  }
  if (/clear route|cancel route/.test(command)) {
    eraseRoute(); routeDestination = null;
    $("#routeDestination").textContent = "No destination selected";
    routeStatus("Route cleared."); feedback("Route cleared.", true); return;
  }
  if (/where am i|locate me|find my location/.test(command)) {
    try {
      const coords = await getCurrentPosition();
      if (map) {
        if (locationMarker) map.removeLayer(locationMarker);
        locationMarker = L.circleMarker(coords, { radius: 10, color: "#0b223b", fillColor: "#a5e2d2", fillOpacity: 1 }).addTo(map);
        locationMarker.bindPopup("Your approximate location");
        map.setView(coords, 14);
      }
      feedback(map ? "Your approximate location was found and the map is centered on it." :
        "Your approximate location was found, but the interactive map is unavailable. Your coordinates are not stored.", true);
    } catch (error) { feedback(error.message, true); }
    return;
  }
  if (/^(?:help|commands|what can you do)/.test(command)) {
    feedback("Try: find pharmacies, find the nearest pharmacy, build a route to the nearest clinic, show bus stops, read route directions, next step, enable high contrast, or increase text size.", true);
    return;
  }
  if (/show all|all places|everything|clear filters|disable accessibility filter/.test(command)) {
    taggedAccessOnly = false; $("#taggedAccessOnly").checked = false;
    ui.search.value = ""; searchTerm = "";
    selectCategory("all"); feedback(`All places. ${ui.count.textContent}.`, true); return;
  }
  if (/^(?:accessibility|show accessible|find accessible|show wheelchair|find wheelchair|wheelchair access|accessibility filter)/.test(command)) {
    taggedAccessOnly = true; $("#taggedAccessOnly").checked = true;
    visibleCount = PAGE_SIZE; render();
    feedback(`Showing places tagged wheelchair accessible. ${ui.count.textContent}. Tags are not verified.`, true); return;
  }
  if (wantsRoute) { await findByVoice(command, true); return; }
  if (placeCategory(command) || /nearest|closest|nearby|^(find|search for|show me)/.test(command)) {
    await findByVoice(command, false); return;
  }
  feedback("Command not recognized. Try 'build a route to the nearest pharmacy', or type 'help'.", true);
}


function stopVoice() {
  const instance = currentRecognition;
  currentRecognition = null;
  if (instance) { try { instance.abort(); } catch { /* Already finished */ } }
  voiceState(false, "Ready");
}
function toggleVoice() {
  if (currentRecognition) { stopVoice(); return; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { feedback("Speech recognition is unavailable. Type a command in the Ask City Eyes box instead."); return; }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  const instance = new Recognition(); currentRecognition = instance;
  instance.lang = "en-US"; instance.interimResults = false; instance.maxAlternatives = 1;
  voiceFeedback = "Starting microphone…"; ui.voice.textContent = voiceFeedback;
  instance.onstart = () => { if (currentRecognition !== instance) return; voiceState(true, "Listening…"); announce("Listening. Speak a command in English."); };
  instance.onresult = (event) => { if (currentRecognition !== instance) return; const transcript = event.results?.[0]?.[0]?.transcript || ""; voiceFeedback = transcript ? `Heard: ${transcript}` : "No speech recognized"; ui.voice.textContent = voiceFeedback; if (transcript) { voiceCommand(transcript).catch(() => feedback("Command could not be completed. Please try again.", true)); } };
  instance.onerror = (event) => { if (currentRecognition !== instance) return; const message = ["not-allowed", "service-not-allowed"].includes(event.error) ? "Microphone access denied. Check browser permissions." : event.error === "no-speech" ? "No speech detected. Try again." : "Speech recognition failed. Please use text search."; voiceFeedback = message; ui.voice.textContent = message; announce(message); };
  instance.onend = () => { if (currentRecognition !== instance) return; currentRecognition = null; const result = ui.voice.textContent !== "Listening…" && ui.voice.textContent !== "Starting microphone…" ? ui.voice.textContent : "Ready"; voiceState(false, result); };
  try { instance.start(); } catch { currentRecognition = null; voiceState(false, "Unable to start microphone"); announce("Could not start voice recognition."); }
}
function interactiveTarget(element) { return element instanceof Element && Boolean(element.closest("button,a,input,textarea,select,summary,[contenteditable],[role='button'],[role='textbox'],.leaflet-container")); }

$("#searchForm").addEventListener("submit", (event) => { event.preventDefault(); searchTerm = ui.search.value.trim(); visibleCount = PAGE_SIZE; render(); announce(`${ui.count.textContent}.`); $("#resultsTitle").scrollIntoView({ block: "start" }); });
ui.search.addEventListener("input", () => { searchTerm = ui.search.value.trim(); visibleCount = PAGE_SIZE; render(); });
$("#clearSearchBtn").addEventListener("click", () => { ui.search.value = ""; searchTerm = ""; visibleCount = PAGE_SIZE; render(); ui.search.focus(); announce("Search cleared."); });
$("#loadMoreBtn").addEventListener("click", () => { const previous = ui.grid.children.length; visibleCount += PAGE_SIZE; render(); const firstNew = ui.grid.children[previous]; const firstButton = firstNew?.querySelector("button"); if (firstButton) firstButton.focus({ preventScroll: true }); announce(ui.count.textContent); });
$("#retryDataBtn").addEventListener("click", loadLocations);
$("#commandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = $("#commandInput").value.trim();
  try { await voiceCommand(command); }
  catch { feedback("Could not complete the command. Please try another request.", true); }
});
document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", async () => {
  $("#commandInput").value = button.dataset.command;
  try { await voiceCommand(button.dataset.command); }
  catch { feedback("Could not complete the command. Please try another request.", true); }
}));
$("#categoryList").addEventListener("click", (event) => { const button = event.target.closest("button[data-category]"); if (button) selectCategory(button.dataset.category); });
$("#taggedAccessOnly").addEventListener("change", (event) => { taggedAccessOnly = event.target.checked; visibleCount = PAGE_SIZE; render(); announce(ui.count.textContent); });
$("#copyReportBtn").addEventListener("click", copyIssueReport);
$("#locateBtn").addEventListener("click", useLocation);
$("#resetMapBtn").addEventListener("click", () => { if (map) map.setView(ALMATY, 12); announce("Map reset to Satbayev University."); });
$("#welcomeBtn").addEventListener("click", () => say("Welcome to City Eyes Almaty. Discover city services using a map, text-based search, or voice commands. Press Space outside controls to start voice search."));
$("#settingsBtn").addEventListener("click", () => ui.settings.showModal());
$("#closeSettingsBtn").addEventListener("click", () => ui.settings.close());
$("#doneSettingsBtn").addEventListener("click", () => ui.settings.close());
$("#contrastBtn").addEventListener("click", () => setContrast(!document.body.classList.contains("high-contrast"), true));
$("#fontSizeRange").addEventListener("input", (event) => setFontSize(event.target.value));
$("#fontSizeRange").addEventListener("change", (event) => setFontSize(event.target.value, true));
$("#closeInfoBtn").addEventListener("click", () => ui.info.close());
$("#doneInfoBtn").addEventListener("click", () => ui.info.close());
$("#readInfoBtn").addEventListener("click", () => { if (selectedPlace) say(detailsText(selectedPlace)); });
$("#planInfoBtn").addEventListener("click", () => { if (selectedPlace && !selectedPlace.isDemo) { ui.info.close(); planRoute(selectedPlace); } });
ui.mic.addEventListener("click", toggleVoice);
$("#howVoiceBtn").addEventListener("click", toggleVoice);
for (const dialog of [ui.settings, ui.info]) dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (ui.settings.open || ui.info.open || interactiveTarget(event.target)) return;
  event.preventDefault(); toggleVoice();
});
window.addEventListener("pagehide", () => { stopVoice(); if ("speechSynthesis" in window) window.speechSynthesis.cancel(); if (fetchController) fetchController.abort(); if (routeRequest) routeRequest.abort(); });
setContrast(storageGet("city-eyes-contrast") === "1");
setFontSize(storageGet("city-eyes-font-size") || 100);
chooseInitialPlaces();
createMap();
render();
loadLocations();
