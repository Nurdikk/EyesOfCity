"use strict";

// City Eyes — English interface, accessible text results and optional map.
// Geographical place data is requested live; no unverified places are hard-coded.
const $ = (selector) => document.querySelector(selector);
const ALMATY = [43.238949, 76.889709];
const PAGE_SIZE = 24;
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


function announce(message) {
  ui.sr.textContent = "";
  window.setTimeout(() => { ui.sr.textContent = message; }, 40);
}
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* Optional */ } }
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
    id: `${item.type}/${item.id}`, kind, lat: latitude, lon: longitude,
    name: tags["name:en"] || tags.name || `${CATEGORIES[kind].replace(/s$/, "")} (unnamed)`,
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
  $("#accessSource").textContent = `Source: OpenStreetMap ${place.id}; community-maintained information, not independently verified.`;
  $("#issueMessage").value = ""; $("#issueType").selectedIndex = 0; $("#reportStatus").textContent = "";
  $("#openOsmLink").href = place.osmUrl;
  const fallback = $("#reportFallback"); if (fallback) fallback.remove();
  if (!ui.info.open) ui.info.showModal();
}
async function copyIssueReport() {
  if (!selectedPlace) return;
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
  if (!map) { announce("Map unavailable. Place information is available in the list."); return; }
  map.setView([place.lat, place.lon], 16);
  for (const marker of markers.getLayers()) {
    if (marker.cityEyesId === place.id) { marker.openPopup(); break; }
  }
  $("#cityMap").focus({ preventScroll: true });
  announce(`Map centered on ${place.name}.`);
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
    const icon = document.createElement("span");
    icon.className = "place-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = ICONS[place.kind];
    const title = document.createElement("h4"); title.textContent = place.name;
    const category = document.createElement("p"); category.textContent = CATEGORIES[place.kind];
    const addr = document.createElement("p"); addr.className = "place-meta"; addr.textContent = place.address;
    const actions = document.createElement("div"); actions.className = "place-card-actions";
    const more = document.createElement("button"); more.className = "card-action"; more.type = "button";
    more.textContent = "Place details →"; more.setAttribute("aria-label", `Details for ${place.name}`);
    more.addEventListener("click", () => showDetails(place));
    const view = document.createElement("button"); view.className = "card-action"; view.type = "button";
    view.textContent = "View on map ↗"; view.setAttribute("aria-label", `Show ${place.name} on map`);
    view.disabled = !map; view.title = map ? "" : "Map is unavailable";
    view.addEventListener("click", () => mapFocus(place));
    const access = document.createElement("p"); access.className = "access-preview";
    const accessInfo = accessStatus(place.accessTags["Wheelchair access"]);
    access.textContent = `Wheelchair access: ${accessInfo.text.toLowerCase()}`;
    const plan = document.createElement("button"); plan.className = "card-action"; plan.type = "button";
    plan.textContent = "Plan route ↗"; plan.setAttribute("aria-label", `Plan a walking route to ${place.name}`);
    plan.addEventListener("click", () => planRoute(place));
    actions.append(more, view, plan); card.append(icon, title, category, addr, access, actions); fragment.append(card);
    if (markers && map) {
      const marker = L.marker([place.lat, place.lon]);
      marker.cityEyesId = place.id;
      const popup = document.createElement("div");
      const strong = document.createElement("strong"); strong.textContent = place.name;
      const address = document.createElement("p"); address.textContent = place.address;
      popup.append(strong, address);
      marker.bindPopup(popup); marker.addTo(markers);
    }
  }
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const heading = document.createElement("strong");
    heading.textContent = dataState === "loading" ? "Loading locations…" : dataState === "error" ? "Places are temporarily unavailable" : "No matching places";
    const paragraph = document.createElement("p");
    paragraph.textContent = dataState === "loading" ? "Results will appear here when loading finishes." : dataState === "error" ? "Select Refresh places to retry. The map and other accessibility controls can still be used." : "Try another search or select All places.";
    empty.append(heading, paragraph); fragment.append(empty);
  }
  grid.append(fragment);
  ui.count.textContent = dataState === "loading" ? "Loading places…" : dataState === "error" ? "Places unavailable" : `Showing ${filtered.length} of ${matched.length} matching places`;
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
async function loadLocations() {
  if (fetchController) fetchController.abort();
  const generation = ++dataGeneration;
  const controller = new AbortController();
  fetchController = controller;
  dataState = "loading";
  $("#retryDataBtn").disabled = true;
  mapStatus("Loading OpenStreetMap places. This can take a few seconds…");
  render();
  // The public Overpass instances provide live community data, with no guaranteed availability.
  const query = `[out:json][timeout:20];(nwr(around:5000,43.238949,76.889709)[amenity=pharmacy];nwr(around:5000,43.238949,76.889709)[shop=chemist];nwr(around:5000,43.238949,76.889709)[amenity~"clinic|doctors|hospital"];nwr(around:5000,43.238949,76.889709)[office~"government|public_service"];nwr(around:5000,43.238949,76.889709)[amenity=public_service];node(around:5000,43.238949,76.889709)[highway=bus_stop];);out center 350;`;
  const endpoints = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter"
  ];
  try {
    let items = null;
    for (const endpoint of endpoints) {
      if (controller.signal.aborted) return;
      const attempt = new AbortController();
      const stopAttempt = () => attempt.abort();
      controller.signal.addEventListener("abort", stopAttempt, { once: true });
      const timeout = window.setTimeout(() => attempt.abort(), 18000);
      try {
        const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: attempt.signal });
        if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
        const json = await response.json();
        if (!Array.isArray(json.elements)) throw new Error("Invalid location data");
        items = json.elements;
        break;
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        window.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", stopAttempt);
      }
    }
    if (generation !== dataGeneration || controller.signal.aborted) return;
    if (!items) throw new Error("All services unavailable");
    const unique = new Map();
    for (const element of items) {
      const place = normalizedLocation(element);
      if (place) unique.set(place.id, place);
    }
    locations = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
    visibleCount = PAGE_SIZE;
    dataState = "ready";
    mapStatus(`Loaded ${locations.length} mapped places within approximately 5 km of central Almaty (public data, maximum 350 records).`);
    render();
    announce(`Loaded ${locations.length} places. Browse the accessible list below.`);
  } catch {
    if (generation !== dataGeneration || controller.signal.aborted) return;
    locations = [];
    dataState = "error";
    mapStatus("Cannot load live places right now. Check your connection, then select Refresh places.");
    render();
    announce("Place data is unavailable. You can refresh places to retry.");
  } finally {
    if (generation === dataGeneration) {
      $("#retryDataBtn").disabled = false;
      fetchController = null;
    }
  }
}

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
    mapStatus("Location found. Results still cover central Almaty; they are not sorted by distance to you.");
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
    return Promise.reject(new Error("Location requires HTTPS or localhost and browser location support. Choose Central Almaty instead."));
  }
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve([coords.latitude, coords.longitude]),
    () => reject(new Error("Location permission was denied or your position was unavailable. Choose Central Almaty instead.")),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
  ));
}
async function planRoute(place) {
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
  try { origin = fromGPS ? await getCurrentPosition() : ALMATY; }
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
    $("#routeSummary").textContent = `${formatDistance(result.distance)} · About ${Math.max(1, Math.round(result.duration / 60))} min on foot (estimate) · ${fromGPS ? "Your approximate location" : "Central Almaty demonstration start"} → ${place.name}`;
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
    say(`Step ${routeStepIndex + 1} of ${routeDirections.length}. ${routeDirections[routeStepIndex]}`);
    routeStepIndex = (routeStepIndex + 1) % routeDirections.length;
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
function voiceCommand(raw) {
  const command = raw.toLocaleLowerCase("en").trim();
  if (/contrast/.test(command)) {
    const enabled = !/off|disable|normal/.test(command);
    setContrast(enabled, true); say(enabled ? "High contrast enabled." : "High contrast disabled."); return;
  }
  if (/bigger text|larger text|increase font|increase text/.test(command)) {
    setFontSize(Number($("#fontSizeRange").value) + 10, true); say(`Text size ${$("#fontSizeValue").textContent}.`); return;
  }
  if (/normal text|reset font/.test(command)) { setFontSize(100, true); say("Text size reset."); return; }
  if (/smaller text|decrease font|decrease text/.test(command)) {
    setFontSize(Number($("#fontSizeRange").value) - 10, true); say(`Text size ${$("#fontSizeValue").textContent}.`); return;
  }
  if (/show all|all places|everything|clear filters|disable accessibility filter/.test(command)) {
    taggedAccessOnly = false; $("#taggedAccessOnly").checked = false;
    ui.search.value = ""; searchTerm = ""; selectCategory("all", true); return;
  }
  if (/^(accessibility|show accessible|find accessible|show wheelchair|find wheelchair|wheelchair access|accessibility filter)/.test(command)) {
    taggedAccessOnly = true; $("#taggedAccessOnly").checked = true; visibleCount = PAGE_SIZE;
    render(); say(`Showing places reported wheelchair accessible. ${ui.count.textContent}. These tags are not verified.`); return;
  }
  if (/read (the )?route|route directions/.test(command) && routeDirections.length) { readRoute(true); return; }
  if (/next step/.test(command) && routeDirections.length) { readRoute(false); return; }
  if (/help|commands/.test(command)) { say("Try pharmacies, clinics, public services, bus stops, all places, enable contrast, increase text, show accessible, show all, read route, next step, or search for a place name."); return; }
  const matches = [
    [/pharmac|chemist|medicine/, "pharmacy"], [/clinic|hospital|doctor/, "clinic"],
    [/public service|government|service center|documents/, "service"],
    [/bus|transport|stop/, "transport"], [/all places|show all|everything/, "all"]
  ];
  const found = matches.find(([pattern]) => pattern.test(command));
  if (found) {
    ui.search.value = ""; searchTerm = "";
    selectCategory(found[1], true);
    $("#explore").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } else if (/^(find|search for|show me) /.test(command)) {
    const term = command.replace(/^(find|search for|show me)\s+/, "");
    ui.search.value = term; searchTerm = term; selectCategory("all");
    say(`${ui.count.textContent} for ${term}.`);
    $("#explore").scrollIntoView({ behavior: "auto" });
  } else say("Command not recognized. Say help to hear available commands.");
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
  if (!Recognition) { ui.voice.textContent = "Speech recognition unavailable"; announce("Speech recognition is unavailable. Please use search or category buttons."); return; }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  const instance = new Recognition(); currentRecognition = instance;
  instance.lang = "en-US"; instance.interimResults = false; instance.maxAlternatives = 1;
  voiceFeedback = "Starting microphone…"; ui.voice.textContent = voiceFeedback;
  instance.onstart = () => { if (currentRecognition !== instance) return; voiceState(true, "Listening…"); announce("Listening. Speak a command in English."); };
  instance.onresult = (event) => { if (currentRecognition !== instance) return; const transcript = event.results?.[0]?.[0]?.transcript || ""; voiceFeedback = transcript ? `Heard: ${transcript}` : "No speech recognized"; ui.voice.textContent = voiceFeedback; if (transcript) voiceCommand(transcript); };
  instance.onerror = (event) => { if (currentRecognition !== instance) return; const message = ["not-allowed", "service-not-allowed"].includes(event.error) ? "Microphone access denied. Check browser permissions." : event.error === "no-speech" ? "No speech detected. Try again." : "Speech recognition failed. Please use text search."; voiceFeedback = message; ui.voice.textContent = message; announce(message); };
  instance.onend = () => { if (currentRecognition !== instance) return; currentRecognition = null; const result = voiceFeedback.startsWith("Heard:") || /denied|failed|detected/.test(voiceFeedback) ? voiceFeedback : "Ready"; voiceState(false, result); };
  try { instance.start(); } catch { currentRecognition = null; voiceState(false, "Unable to start microphone"); announce("Could not start voice recognition."); }
}
function interactiveTarget(element) { return element instanceof Element && Boolean(element.closest("button,a,input,textarea,select,summary,[contenteditable],[role='button'],[role='textbox'],.leaflet-container")); }

$("#searchForm").addEventListener("submit", (event) => { event.preventDefault(); searchTerm = ui.search.value.trim(); visibleCount = PAGE_SIZE; render(); announce(`${ui.count.textContent}.`); $("#resultsTitle").scrollIntoView({ block: "start" }); });
ui.search.addEventListener("input", () => { searchTerm = ui.search.value.trim(); visibleCount = PAGE_SIZE; render(); });
$("#clearSearchBtn").addEventListener("click", () => { ui.search.value = ""; searchTerm = ""; visibleCount = PAGE_SIZE; render(); ui.search.focus(); announce("Search cleared."); });
$("#loadMoreBtn").addEventListener("click", () => { const previous = ui.grid.children.length; visibleCount += PAGE_SIZE; render(); const firstNew = ui.grid.children[previous]; const firstButton = firstNew?.querySelector("button"); if (firstButton) firstButton.focus({ preventScroll: true }); announce(ui.count.textContent); });
$("#retryDataBtn").addEventListener("click", loadLocations);
$("#categoryList").addEventListener("click", (event) => { const button = event.target.closest("button[data-category]"); if (button) selectCategory(button.dataset.category); });
$("#taggedAccessOnly").addEventListener("change", (event) => { taggedAccessOnly = event.target.checked; visibleCount = PAGE_SIZE; render(); announce(ui.count.textContent); });
$("#copyReportBtn").addEventListener("click", copyIssueReport);
$("#locateBtn").addEventListener("click", useLocation);
$("#resetMapBtn").addEventListener("click", () => { if (map) map.setView(ALMATY, 12); announce("Map reset to central Almaty."); });
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
createMap();
render();
loadLocations();
