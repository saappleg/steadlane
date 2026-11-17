import { createAuthClient } from "./auth.js";
import { createBookingApi } from "./booking-api.js";
import { createRouteMap } from "./map.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const appShell = $("#app-shell");
const authView = $("#auth-view");
const passengerView = $("#passenger-view");
const driverView = $("#driver-view");
const siteNav = $("#site-nav");
const accountLabel = $("#account-label");
const driverNavButton = $("#nav-driver");
const passengerNavButtons = [$("#nav-booking"), $("#nav-history")];
const authMessage = $("#auth-message");
const offlineNotice = $("#offline-notice");
const loginEmailInput = $("#login-email");
const passwordRecoveryPanel = $("#password-recovery-panel");
const signInButton = $("#nav-signin");
const signOutButton = $("#sign-out-button");

const pickupInput = $("#pickup");
const destinationInput = $("#destination");
const pickupTimeInput = $("#pickup-time");
const passengersInput = $("#passengers");
const rideForm = $("#ride-form");
const rideFormError = $("#ride-form-error");
const routeStatus = $("#route-status");
const routeLoading = $("#route-loading");
const routeEmpty = $("#route-empty");
const routeError = $("#route-error");
const routeResult = $("#route-result");
const quoteEmpty = $("#quote-empty");
const quoteLoading = $("#quote-loading");
const quoteError = $("#quote-error");
const quoteExpired = $("#quote-expired");
const quoteDetails = $("#quote-details");
const requestRideButton = $("#request-ride-button");
const bookingStatus = $("#booking-status");
const bookingStatusMessage = $("#booking-status-message");
const cancelRideButton = $("#cancel-ride-button");
const payForRideButton = $("#pay-for-ride-button");
const routeMapElement = $("#route-map");
const mapLoading = $("#map-loading");
const mapError = $("#map-error");

const stopIndexes = [1, 2, 3];
const addressKinds = ["pickup", ...stopIndexes.map((index) => `stop-${index}`), "destination"];
const selectedPlaces = Object.fromEntries(addressKinds.map((kind) => [kind, null]));
const autocomplete = Object.fromEntries(addressKinds.map((kind) => [kind, {
  timer: null,
  controller: null,
  suggestions: [],
  activeIndex: -1,
  fullAddressAvailable: false,
  fullAddressSearching: false,
  searching: false,
  requestSequence: 0,
}]));

const currencyFormatters = new Map();
const checkoutReturnParams = new URLSearchParams(window.location.search);
const checkoutReturnBookingId = checkoutReturnParams.get("checkout") === "return"
  ? checkoutReturnParams.get("booking_id")
  : null;
const historyBookings = new Map();
let authClient = null;
let bookingApi = null;
let routeMap = null;
let currentQuote = null;
let currentTrip = null;
let currentBooking = null;
let bookingIdempotencyKey = null;
let quoteRequestSequence = 0;
let sessionSequence = 0;
let authSubscription = null;
let isPasswordRecovery = false;
let quoteExpiryTimer = null;
let isRequestingBooking = false;
let isCancellingBooking = false;
let isLoadingHistory = false;
let isLoadingDriverQueue = false;
let isLoadingAvailability = false;
let isSavingAvailability = false;
let isRequestingRecurring = false;
let signedInRole = null;
let authSetupError = "";
let stripePaymentsEnabled = false;
let currentRecurringSeries = null;
let activeCheckoutBookingId = null;
let checkoutReturnHandled = false;

function text(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function hidden(selector, isHidden) {
  const element = $(selector);
  if (element) element.hidden = isHidden;
}

function setAuthMessage(message, kind = "info") {
  authMessage.textContent = message;
  authMessage.dataset.kind = kind;
}

function setFormError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function errorMessage(error, fallback) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function formatter(currencyCode = "USD") {
  if (!currencyFormatters.has(currencyCode)) {
    try {
      currencyFormatters.set(
        currencyCode,
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: currencyCode,
        }),
      );
    } catch {
      currencyFormatters.set(
        currencyCode,
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: "USD",
        }),
      );
    }
  }
  return currencyFormatters.get(currencyCode);
}

function formatCurrency(value, currencyCode = "USD") {
  return formatter(currencyCode).format(value);
}

function formatPickupTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time not available";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: EASTERN_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

const EASTERN_TIME_ZONE = "America/New_York";

function easternParts(date) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(values.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function toEasternDateInput(date) {
  const parts = easternParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function toEasternDateTimeInput(date) {
  const parts = easternParts(date);
  return `${toEasternDateInput(date)}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function setMinimumPickupTime() {
  const now = new Date();
  const minimum = new Date(now.getTime() + 5 * 60 * 1000);
  const defaultPickup = new Date(now.getTime() + 60 * 60 * 1000);
  pickupTimeInput.min = toEasternDateTimeInput(minimum);
  if (!pickupTimeInput.value) pickupTimeInput.value = toEasternDateTimeInput(defaultPickup);
  const startDate = toEasternDateInput(defaultPickup);
  $("#recurrence-start").value ||= startDate;
  $("#recurrence-end").value ||= startDate;
  $("#recurrence-time").value ||= toEasternDateTimeInput(defaultPickup).slice(11, 16);
}

function showAuthView(message = "") {
  authView.hidden = false;
  passengerView.hidden = true;
  driverView.hidden = true;
  siteNav.hidden = true;
  accountLabel.hidden = true;
  signInButton.hidden = true;
  signOutButton.hidden = true;
  appShell.dataset.authState = "signed-out";
  setAuthMessage(authSetupError || message, authSetupError ? "error" : "info");
}

function showPublicPlanner(message = "") {
  signedInRole = null;
  authView.hidden = true;
  passengerView.hidden = false;
  driverView.hidden = true;
  siteNav.hidden = false;
  accountLabel.hidden = true;
  signInButton.hidden = false;
  signInButton.disabled = Boolean(authSetupError) || !authClient;
  signOutButton.hidden = true;
  appShell.dataset.authState = "signed-out";
  $("#nav-booking").hidden = false;
  $("#nav-booking").classList.add("is-active");
  $("#nav-booking").setAttribute("aria-pressed", "true");
  $("#nav-history").hidden = true;
  driverNavButton.hidden = true;
  $(".local-nav").hidden = true;
  $("#passenger-booking-panel").hidden = false;
  $("#passenger-history-panel").hidden = true;
  if (!currentQuote) {
    routeEmpty.hidden = false;
    quoteEmpty.hidden = false;
    text("#route-empty", "Choose a pickup and destination to find a route.");
  }
  if (message) text("#route-status", message);
}

function clearPassengerSessionState() {
  currentBooking = null;
  historyBookings.clear();
  activeCheckoutBookingId = null;
  bookingStatus.hidden = true;
  bookingStatusMessage.textContent = "";
  payForRideButton.hidden = true;
}

function showPassengerPanel(name) {
  const panelName = name === "history" ? "history" : "booking";
  for (const panel of $$("[data-passenger-panel]").filter((item) => item.closest("#passenger-view"))) {
    panel.hidden = panel.dataset.passengerPanel !== panelName;
  }
  for (const button of passengerNavButtons) {
    const active = button.dataset.passengerPanelTarget === panelName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of $$(".local-nav__button")) {
    const active = button.dataset.passengerPanelTarget === panelName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (panelName === "history") void loadHistory();
}

function showDriverView() {
  authView.hidden = true;
  passengerView.hidden = true;
  driverView.hidden = false;
  passengerNavButtons.forEach((button) => {
    button.hidden = true;
    button.classList.remove("is-active");
    button.setAttribute("aria-pressed", "false");
  });
  driverNavButton.hidden = false;
  driverNavButton.classList.add("is-active");
  driverNavButton.setAttribute("aria-pressed", "true");
  void loadDriverQueue();
  void loadDriverAvailability();
}

function showRoleView(profile, email) {
  const role = profile?.role;
  if (role !== "passenger" && role !== "driver") {
    throw new Error("This account does not have Steadlane beta access.");
  }

  authView.hidden = true;
  siteNav.hidden = false;
  accountLabel.hidden = false;
  accountLabel.textContent = profile.fullName || email || "Steadlane account";
  signInButton.hidden = true;
  signOutButton.hidden = false;
  appShell.dataset.authState = "signed-in";

  if (role === "driver") {
    signedInRole = "driver";
    passengerNavButtons.forEach((button) => {
      button.hidden = true;
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });
    driverNavButton.hidden = false;
    showDriverView();
    text("#driver-account-label", profile.fullName || email || "Driver account");
    return;
  }

  passengerView.hidden = false;
  driverView.hidden = true;
  signedInRole = "passenger";
  driverNavButton.hidden = true;
  $(".local-nav").hidden = true;
  passengerNavButtons.forEach((button) => {
    button.hidden = false;
  });
  showPassengerPanel("booking");
  if (currentQuote && !currentQuote.id && selectedPlaces.pickup && selectedPlaces.destination) {
    void requestRouteAndFare({ preventDefault() {} });
  }
}

function setAuthFormBusy(form, isBusy) {
  form.setAttribute("aria-busy", String(isBusy));
  for (const button of form.querySelectorAll("button[type='submit']")) {
    button.disabled = isBusy;
  }
}

function showAuthTab(mode) {
  const selectedMode = mode === "signup" ? "signup" : "login";
  isPasswordRecovery = false;
  passwordRecoveryPanel.hidden = true;
  $("#login-form").hidden = false;
  $("#forgot-password-button").hidden = false;
  $("#forgot-password-help").hidden = false;
  $("#password-reset-feedback").hidden = false;
  $("#login-status").hidden = false;
  for (const button of $$("[data-auth-mode]")) {
    const active = button.dataset.authMode === selectedMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of $$("[data-auth-panel]")) {
    panel.hidden = panel.dataset.authPanel !== selectedMode;
  }
  setAuthMessage(authSetupError, authSetupError ? "error" : "info");
}

function showPasswordRecoveryPanel({ focus = false } = {}) {
  showAuthView();
  for (const button of $$("[data-auth-mode]")) {
    const active = button.dataset.authMode === "login";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of $$("[data-auth-panel]")) {
    panel.hidden = panel.dataset.authPanel !== "login";
  }
  $("#login-form").hidden = true;
  $("#forgot-password-button").hidden = true;
  $("#forgot-password-help").hidden = true;
  $("#password-reset-feedback").hidden = true;
  $("#login-status").hidden = true;
  passwordRecoveryPanel.hidden = false;
  if (focus) $("#password-recovery-heading").focus();
}

function hidePasswordRecoveryPanel({ focus = false } = {}) {
  isPasswordRecovery = false;
  passwordRecoveryPanel.hidden = true;
  $("#login-form").hidden = false;
  $("#forgot-password-button").hidden = false;
  $("#forgot-password-help").hidden = false;
  $("#password-reset-feedback").hidden = false;
  $("#login-status").hidden = false;
  if (focus) loginEmailInput.focus();
}

function addressInput(kind) {
  return $(`#${kind}`);
}

function addressList(kind) {
  return $(`#${kind}-options`);
}

function clearAutocomplete(kind) {
  const input = addressInput(kind);
  const list = addressList(kind);
  const state = autocomplete[kind];
  clearTimeout(state.timer);
  state.timer = null;
  state.requestSequence += 1;
  state.controller?.abort();
  state.controller = null;
  state.suggestions = [];
  state.activeIndex = -1;
  state.fullAddressAvailable = false;
  state.fullAddressSearching = false;
  state.searching = false;
  list.replaceChildren();
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-busy");
  input.removeAttribute("aria-activedescendant");
}

function closeAutocomplete(kind) {
  const input = addressInput(kind);
  const list = addressList(kind);
  autocomplete[kind].activeIndex = -1;
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function setActiveSuggestion(kind, index) {
  const input = addressInput(kind);
  const list = addressList(kind);
  const state = autocomplete[kind];
  if (!state.suggestions.length) return;
  const lastIndex = state.suggestions.length - 1;
  state.activeIndex = Math.max(0, Math.min(index, lastIndex));
  const options = [...list.querySelectorAll("[role='option']")];
  options.forEach((option, optionIndex) => {
    const active = optionIndex === state.activeIndex;
    option.setAttribute("aria-selected", String(active));
    if (active) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

function renderSuggestions(kind, suggestions) {
  const input = addressInput(kind);
  const list = addressList(kind);
  const state = autocomplete[kind];
  state.suggestions = suggestions;
  state.activeIndex = -1;
  state.fullAddressAvailable = false;
  list.replaceChildren();

  suggestions.forEach((suggestion, index) => {
    const option = document.createElement("li");
    option.id = `${kind}-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.dataset.suggestionIndex = String(index);
    option.textContent = suggestion.label;
    list.append(option);
  });

  list.hidden = suggestions.length === 0;
  input.setAttribute("aria-expanded", String(suggestions.length > 0));
  input.removeAttribute("aria-activedescendant");
  if (suggestions.length) {
    setAddressStatus(kind, `${suggestions.length} address suggestions. Use the arrow keys to choose one.`);
  }
}

function setAddressStatus(kind, message) {
  if (document.activeElement === addressInput(kind)) routeStatus.textContent = message;
}

function isCurrentAddressSearch(kind, query, requestSequence, controller) {
  return !controller.signal.aborted &&
    autocomplete[kind].requestSequence === requestSequence &&
    addressInput(kind).value.trim() === query;
}

function selectSuggestion(kind, index) {
  const state = autocomplete[kind];
  const suggestion = state.suggestions[index];
  const input = addressInput(kind);
  if (!suggestion) return;

  selectedPlaces[kind] = suggestion;
  input.value = suggestion.label;
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  clearAutocomplete(kind);
  const label = kind === "pickup" ? "Pickup" : kind === "destination" ? "Destination" : `Stop ${kind.slice(-1)}`;
  routeStatus.textContent = `${label} selected.`;
  invalidateRouteAndQuote("Trip details changed. Get a new route and fare before requesting a ride.");
}

function queueAddressSearch(kind) {
  const input = addressInput(kind);
  const state = autocomplete[kind];
  const query = input.value.trim();
  clearTimeout(state.timer);
  state.controller?.abort();
  state.controller = null;
  selectedPlaces[kind] = null;
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  clearAutocomplete(kind);
  const requestSequence = state.requestSequence;
  invalidateRouteAndQuote("Trip details changed. Get a new route and fare before requesting a ride.");

  if (!query) {
    setAddressStatus(kind, "");
    return;
  }
  if (!bookingApi) {
    setAddressStatus(kind, "Address search is not configured yet. Try again later.");
    return;
  }
  if (query.length < 3) {
    setAddressStatus(kind, "Enter at least three characters to search for an address.");
    return;
  }

  state.searching = true;
  input.setAttribute("aria-busy", "true");
  setAddressStatus(kind, "Searching for addresses…");
  state.timer = window.setTimeout(async () => {
    state.timer = null;
    if (state.requestSequence !== requestSequence || input.value.trim() !== query) return;
    const controller = new AbortController();
    state.controller = controller;
    try {
      const result = await bookingApi.searchAddresses(query, { signal: controller.signal });
      if (!isCurrentAddressSearch(kind, query, requestSequence, controller)) return;
      const suggestions = Array.isArray(result?.suggestions)
        ? result.suggestions.filter((item) =>
            typeof item?.label === "string" &&
            typeof item?.placeId === "string" &&
            item.placeId.trim().length > 0,
          )
        : [];
      state.searching = false;
      input.removeAttribute("aria-busy");
      renderSuggestions(kind, suggestions);
      if (!suggestions.length) {
        state.fullAddressAvailable = true;
        setAddressStatus(kind, "No quick matches. Press Enter to search the full address.");
      }
    } catch {
      if (!isCurrentAddressSearch(kind, query, requestSequence, controller)) return;
      state.searching = false;
      input.removeAttribute("aria-busy");
      state.fullAddressAvailable = true;
      setAddressStatus(kind, "Quick address search is unavailable. Press Enter to search the full address.");
      closeAutocomplete(kind);
    } finally {
      if (state.requestSequence === requestSequence && state.controller === controller) {
        state.controller = null;
      }
    }
  }, 300);
}

async function searchFullAddress(kind, { force = false } = {}) {
  const input = addressInput(kind);
  const state = autocomplete[kind];
  const query = input.value.trim();
  if ((!force && !state.fullAddressAvailable) || state.fullAddressSearching || query.length < 3 || !bookingApi) return;

  clearTimeout(state.timer);
  state.timer = null;
  state.requestSequence += 1;
  const requestSequence = state.requestSequence;
  state.controller?.abort();
  state.fullAddressAvailable = false;
  state.fullAddressSearching = true;
  state.searching = false;
  input.setAttribute("aria-busy", "true");
  state.suggestions = [];
  state.activeIndex = -1;
  const list = addressList(kind);
  list.replaceChildren();
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  const controller = new AbortController();
  state.controller = controller;
  setAddressStatus(kind, "Searching the full address…");

  try {
    const result = await bookingApi.searchAddresses(query, {
      signal: controller.signal,
      fullAddress: true,
    });
    if (!isCurrentAddressSearch(kind, query, requestSequence, controller)) return;
    const suggestions = Array.isArray(result?.suggestions)
      ? result.suggestions.filter((item) =>
          typeof item?.label === "string" &&
          typeof item?.placeId === "string" &&
          item.placeId.trim().length > 0,
        )
      : [];
    renderSuggestions(kind, suggestions);
    if (!suggestions.length) {
      state.fullAddressAvailable = true;
      setAddressStatus(kind, "No matching addresses. Add the city, state, or ZIP code and press Enter to search again.");
    }
  } catch (error) {
    if (!isCurrentAddressSearch(kind, query, requestSequence, controller)) return;
    state.fullAddressAvailable = true;
    setAddressStatus(kind, `${errorMessage(error, "Full address search is unavailable.")} Press Enter to try again.`);
    closeAutocomplete(kind);
  } finally {
    if (state.requestSequence === requestSequence && state.controller === controller) {
      state.controller = null;
      state.fullAddressSearching = false;
      input.removeAttribute("aria-busy");
    }
  }
}

function setupAutocomplete(kind) {
  const input = addressInput(kind);
  const list = addressList(kind);

  input.addEventListener("input", () => queueAddressSearch(kind));
  input.addEventListener("keydown", (event) => {
    const state = autocomplete[kind];
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.suggestions.length) {
        selectSuggestion(kind, state.activeIndex >= 0 ? state.activeIndex : 0);
        return;
      }
      if (state.fullAddressSearching) return;

      const query = input.value.trim();
      if (query.length < 3) {
        setAddressStatus(kind, "Enter at least three characters to search for an address.");
        return;
      }
      if (!bookingApi) {
        setAddressStatus(kind, "Address search is not configured yet. Try again later.");
        return;
      }
      void searchFullAddress(kind, { force: true });
      return;
    }
    if (event.key === "ArrowDown" && state.suggestions.length) {
      event.preventDefault();
      if (list.hidden) list.hidden = false;
      setActiveSuggestion(kind, state.activeIndex + 1);
    } else if (event.key === "ArrowUp" && state.suggestions.length) {
      event.preventDefault();
      if (list.hidden) list.hidden = false;
      setActiveSuggestion(kind, state.activeIndex < 0 ? 0 : state.activeIndex - 1);
    } else if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      closeAutocomplete(kind);
    }
  });
  list.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[role='option']")) event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[role='option']");
    if (!option) return;
    selectSuggestion(kind, Number(option.dataset.suggestionIndex));
  });
}

function activeStops() {
  return stopIndexes.flatMap((index) => {
    const kind = `stop-${index}`;
    const input = addressInput(kind);
    const place = selectedPlaces[kind];
    if (!input.value.trim() && !place) return [];
    return [{ kind, input, place }];
  });
}

function easternWallTimeCandidates(dateTime) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(dateTime || "");
  if (!match) return [];
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (
    new Date(wallUtc).getUTCFullYear() !== year ||
    new Date(wallUtc).getUTCMonth() + 1 !== month ||
    new Date(wallUtc).getUTCDate() !== day ||
    hour > 23 || minute > 59
  ) return [];

  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = new Date(wallUtc + hours * 60 * 60 * 1000);
    const parts = easternParts(probe);
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    offsets.add(Math.round((representedUtc - probe.getTime()) / 60_000));
  }

  return [...offsets]
    .map((offset) => new Date(wallUtc - offset * 60_000))
    .filter((candidate) => {
      const parts = easternParts(candidate);
      return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
    })
    .sort((left, right) => left - right);
}

function dateOnlyUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? date
    : null;
}

function isoWeekday(date) {
  return date.getUTCDay() === 0 ? 7 : date.getUTCDay();
}

function validateRecurringPlan() {
  const weekdays = $$('input[name="weekdays"]:checked').map((input) => Number(input.value)).sort((a, b) => a - b);
  const startValue = $("#recurrence-start").value;
  const endValue = $("#recurrence-end").value;
  const time = $("#recurrence-time").value;
  const start = dateOnlyUtc(startValue);
  const end = dateOnlyUtc(endValue);
  if (!weekdays.length) return { error: "Choose at least one weekday for weekly rides." };
  if (!start || !end || !time) return { error: "Choose a first date, last date, and pickup time for weekly rides." };
  if (end < start) return { error: "The last date must be on or after the first date." };
  const dateSpan = (end.getTime() - start.getTime()) / 86_400_000;
  if (dateSpan > 89) return { error: "Weekly rides can cover at most 90 calendar days, including the first and last date." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "Choose a valid Eastern pickup time." };

  const occurrences = [];
  for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    if (!weekdays.includes(isoWeekday(cursor))) continue;
    const dateValue = cursor.toISOString().slice(0, 10);
    const candidates = easternWallTimeCandidates(`${dateValue}T${time}`);
    if (candidates.length !== 1) {
      return {
        error: candidates.length === 0
          ? `${dateValue} ${time} does not exist in Eastern Time because of the daylight-saving clock change. Choose another pickup time.`
          : `${dateValue} ${time} is ambiguous in Eastern Time because clocks change that day. Choose another pickup time.`,
      };
    }
    occurrences.push({ date: dateValue, at: candidates[0] });
  }
  if (!occurrences.length) return { error: "No selected weekday falls between the first and last dates." };
  if (occurrences[0].at.getTime() < Date.now() + 5 * 60 * 1000) {
    return { error: "The first selected pickup must be at least five minutes in the future." };
  }
  return { weekdays, startDate: startValue, endDate: endValue, pickupTime: time, occurrences };
}

function clearBookingStatus() {
  currentBooking = null;
  bookingStatus.hidden = true;
  bookingStatusMessage.textContent = "";
  cancelRideButton.hidden = true;
  payForRideButton.hidden = true;
  text("#booking-accepted-payment-status", "");
  text("#checkout-feedback", "");
  hidden("#checkout-error", true);
  $("#recurring-booking-state").hidden = true;
  for (const state of ["requested", "accepted", "declined", "cancelled"]) {
    hidden(`#booking-${state}`, true);
  }
}

function invalidateRouteAndQuote(message) {
  quoteRequestSequence += 1;
  clearTimeout(quoteExpiryTimer);
  currentQuote = null;
  currentTrip = null;
  currentRecurringSeries = null;
  bookingIdempotencyKey = null;
  rideForm.removeAttribute("aria-busy");
  for (const button of rideForm.querySelectorAll("button")) button.disabled = !navigator.onLine;
  requestRideButton.disabled = true;
  requestRideButton.hidden = true;
  $("#request-recurring-button").hidden = true;
  $("#signin-to-request-button").hidden = true;
  hidden("#stop-warning", true);
  quoteDetails.hidden = true;
  quoteLoading.hidden = true;
  quoteError.hidden = true;
  quoteExpired.hidden = true;
  quoteEmpty.hidden = false;
  routeLoading.hidden = true;
  routeError.hidden = true;
  routeEmpty.hidden = false;
  routeResult.hidden = true;
  mapLoading.hidden = true;
  mapError.hidden = true;
  text("#quote-empty", message || "Enter your pickup and destination to get a route and fare estimate.");
  text("#route-distance", "—");
  text("#route-duration", "—");
  routeStatus.textContent = message || "";
  routeMap?.clearRoute();
  clearBookingStatus();
}

function setRouteBusy(isBusy) {
  rideForm.setAttribute("aria-busy", String(isBusy));
  for (const button of rideForm.querySelectorAll("button")) button.disabled = isBusy || !navigator.onLine;
  routeLoading.hidden = !isBusy;
  quoteLoading.hidden = !isBusy;
  if (isBusy) {
    quoteEmpty.hidden = true;
    routeEmpty.hidden = true;
    routeError.hidden = true;
    quoteError.hidden = true;
  }
}

function isValidQuote(quote) {
  const hasValidExpiry = quote?.expiresAt == null
    ? quote?.id === null
    : Number.isFinite(new Date(quote.expiresAt).getTime());
  return Boolean(
    quote &&
      (quote.id === null || typeof quote.id === "string") &&
      hasValidExpiry &&
      quote.route &&
      Number.isFinite(quote.route.distanceMiles) &&
      Number.isFinite(quote.route.durationMinutes) &&
      quote.fare &&
      Number.isFinite(quote.fare.knownSubtotal) &&
      (quote.fare.total === null || Number.isFinite(quote.fare.total)) &&
      (typeof quote.bookingAllowed === "boolean" || typeof quote.bookingEligible === "boolean" || typeof quote.fare.bookable === "boolean"),
  );
}

function quoteAllowsBooking(quote) {
  if (typeof quote?.bookingAllowed === "boolean") return quote.bookingAllowed;
  if (typeof quote?.bookingEligible === "boolean") return quote.bookingEligible;
  return quote?.fare?.bookable === true;
}

function hasUnpricedStops(quote) {
  const stopCount = Number(quote?.fare?.stopCount ?? quote?.stopCount ?? activeStops().length);
  return stopCount > 0 && quote?.fare?.stopCharge === null;
}

function updateQuoteActions(quote) {
  const signedInPassenger = signedInRole === "passenger";
  const recurring = $("#repeat-weekly-toggle").checked;
  updateRequestPaymentCopy();
  const validFare = Boolean(
    quoteAllowsBooking(quote) &&
      quote.id &&
      Number.isFinite(quote.fare?.total) &&
      !hasUnpricedStops(quote) &&
      new Date(quote.expiresAt).getTime() > Date.now(),
  );
  const hasSubmittedRide = Boolean(currentBooking || currentRecurringSeries);
  const knownSubtotalOnly = hasUnpricedStops(quote) || quote?.fare?.total === null;
  $("#signin-to-request-button").hidden = signedInPassenger;
  $("#signin-to-request-button").disabled = Boolean(authSetupError) || !authClient || !navigator.onLine;
  requestRideButton.hidden = !signedInPassenger || recurring;
  requestRideButton.textContent = "Request this ride";
  requestRideButton.disabled = !signedInPassenger || !validFare || !navigator.onLine || hasSubmittedRide;
  $("#request-recurring-button").hidden = !signedInPassenger || !recurring;
  $("#request-recurring-button").disabled = !signedInPassenger || !validFare || !navigator.onLine || hasSubmittedRide;
  hidden("#unpriced-stop-note", !knownSubtotalOnly);
  hidden("#fare-known-subtotal-row", !knownSubtotalOnly);
  hidden("#fare-total-row", !Number.isFinite(quote?.fare?.total));
  hidden("#stop-warning", !hasUnpricedStops(quote));
}

function renderFare(quote) {
  const currencyCode = quote.currency || "USD";
  const fare = quote.fare;
  const needsSubtotalLabel = fare.total === null || hasUnpricedStops(quote);
  text("#estimate-total-label", needsSubtotalLabel ? "Known subtotal" : "Estimated fare");
  $("#estimate-total").setAttribute("aria-label", needsSubtotalLabel ? "Known fare subtotal" : "Estimated fare");
  text("#estimate-total", Number.isFinite(fare.total) ? formatCurrency(fare.total, currencyCode) : formatCurrency(fare.knownSubtotal, currencyCode));
  text("#fare-base", formatCurrency(fare.baseFare, currencyCode));
  text(
    "#fare-distance",
    `${quote.route.distanceMiles.toFixed(1)} mi · ${formatCurrency(fare.distanceCharge, currencyCode)}`,
  );
  text(
    "#fare-duration",
    `${Math.round(quote.route.durationMinutes)} min · ${formatCurrency(fare.durationCharge, currencyCode)}`,
  );
  hidden("#minimum-adjustment-row", !(fare.minimumAdjustment > 0));
  text("#fare-minimum-adjustment", formatCurrency(fare.minimumAdjustment || 0, currencyCode));
  text("#fare-booking-fee", formatCurrency(fare.bookingFee, currencyCode));
  text("#fare-stop-charge", Number.isFinite(fare.stopCharge) ? formatCurrency(fare.stopCharge, currencyCode) : "Not priced");
  hidden("#fare-stop-row", activeStops().length === 0);
  text("#fare-known-subtotal", formatCurrency(fare.knownSubtotal, currencyCode));
  text("#fare-total", Number.isFinite(fare.total) ? formatCurrency(fare.total, currencyCode) : "Not available");
  renderTripReview(currentTrip);
  const hasStops = activeStops().length > 0;
  const stopStatus = hasStops && fare.stopCharge === null
    ? " Stop charge is not priced; the amount shown is a subtotal."
    : hasStops
      ? ` Includes ${formatCurrency(fare.stopCharge, currencyCode)} for stops.`
      : "";
  text(
    "#unpriced-stop-note",
    hasUnpricedStops(quote)
      ? "Stop pricing is incomplete. This subtotal is for planning only, and this route cannot be requested yet."
      : "A complete fare is not available for this route. This known subtotal is for planning only.",
  );
  const expiryTime = quote.expiresAt
    ? new Intl.DateTimeFormat(undefined, { timeZone: EASTERN_TIME_ZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(quote.expiresAt))
    : "sign in to refresh before requesting";
  text("#quote-validity", `${quote.provisional ? "Provisional beta estimate · " : "Estimate · "}${quote.expiresAt ? `valid until ${expiryTime}` : expiryTime}${stopStatus}`);
  const quoteNote = $(".quote-note");
  if (quoteNote) {
    quoteNote.textContent = quote.provisional
      ? "This provisional beta estimate uses sample rates. It is not a confirmed fare; the ride is confirmed only after a driver accepts."
      : "This estimate uses the returned route and fare. The ride is confirmed only after a driver accepts.";
  }
  quoteDetails.hidden = false;
  quoteEmpty.hidden = true;
  quoteError.hidden = true;
  quoteExpired.hidden = true;
  updateQuoteActions(quote);
}

function renderTripReview(trip) {
  if (!trip) return;
  text("#review-pickup", selectedPlaces.pickup?.label || "Pickup unavailable");
  text("#review-destination", selectedPlaces.destination?.label || "Destination unavailable");
  const stopLabels = activeStops().map((stop) => selectedPlaces[stop.kind]?.label).filter(Boolean);
  hidden("#review-stops-row", stopLabels.length === 0);
  text("#review-stops", stopLabels.join(" · "));
  text("#review-passengers", `${trip.passengerCount} ${trip.passengerCount === 1 ? "passenger" : "passengers"}`);
  if (trip.recurrence) {
    const names = trip.recurrence.weekdays.map((day) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day - 1))));
    text("#review-schedule", `${names.join(", ")} · ${trip.recurrence.pickupTime} ET · ${trip.recurrence.startDate} to ${trip.recurrence.endDate}`);
  } else {
    text("#review-schedule", new Intl.DateTimeFormat(undefined, {
      timeZone: EASTERN_TIME_ZONE,
      weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(trip.pickupAt)));
  }
}

function setQuoteExpired() {
  if (!currentQuote?.expiresAt || new Date(currentQuote.expiresAt).getTime() > Date.now()) return;
  quoteExpired.hidden = false;
  requestRideButton.disabled = true;
  $("#request-recurring-button").disabled = true;
  text("#quote-validity", "This provisional fare estimate has expired.");
}

function scheduleQuoteExpiry(quote) {
  clearTimeout(quoteExpiryTimer);
  if (!quote.expiresAt) return;
  const remaining = new Date(quote.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    setQuoteExpired();
    return;
  }
  quoteExpiryTimer = window.setTimeout(setQuoteExpired, remaining + 25);
}

function selectedAddress(kind) {
  const input = addressInput(kind);
  const place = selectedPlaces[kind];
  if (!place || input.value.trim() !== place.label) {
    input.setCustomValidity("Choose an address from the suggestions.");
    input.setAttribute("aria-invalid", "true");
    return null;
  }
  if (typeof place.placeId !== "string" || !place.placeId.trim()) {
    input.setCustomValidity("Choose a valid address from the suggestions.");
    input.setAttribute("aria-invalid", "true");
    return null;
  }
  return { placeId: place.placeId };
}

function validateTrip() {
  setFormError(rideFormError, "");
  for (const kind of addressKinds) {
    addressInput(kind).setCustomValidity("");
    addressInput(kind).removeAttribute("aria-invalid");
  }
  pickupTimeInput.setCustomValidity("");
  $("#recurrence-start").setCustomValidity("");
  $("#recurrence-end").setCustomValidity("");
  if (!rideForm.checkValidity()) {
    rideForm.reportValidity();
    setFormError(rideFormError, "Check the highlighted trip details.");
    return null;
  }

  const pickup = selectedAddress("pickup");
  const destination = selectedAddress("destination");
  if (!pickup || !destination) {
    rideForm.reportValidity();
    setFormError(rideFormError, "Choose a pickup and destination from the address suggestions.");
    return null;
  }
  const stops = [];
  for (const stop of activeStops()) {
    const selected = selectedAddress(stop.kind);
    if (!selected) {
      stop.input.focus();
      setFormError(rideFormError, `Choose Stop ${stop.kind.slice(-1)} from its address suggestions, or remove it.`);
      return null;
    }
    stops.push(selected);
  }
  const places = [
    { kind: "pickup", input: pickupInput, place: selectedPlaces.pickup, selection: pickup },
    ...activeStops().map((stop, index) => ({ ...stop, selection: stops[index] })),
    { kind: "destination", input: destinationInput, place: selectedPlaces.destination, selection: destination },
  ];
  const seenPlaceIds = new Set();
  const seenLabels = new Set();
  for (const item of places) {
    const normalizedLabel = item.input.value.trim().toLocaleLowerCase();
    if (seenPlaceIds.has(item.selection.placeId) || seenLabels.has(normalizedLabel)) {
      item.input.setCustomValidity("Each stop must be at a different location.");
      item.input.setAttribute("aria-invalid", "true");
      item.input.focus();
      setFormError(rideFormError, "Pickup, stops, and destination must all be different locations.");
      return null;
    }
    seenPlaceIds.add(item.selection.placeId);
    seenLabels.add(normalizedLabel);
  }

  const recurring = $("#repeat-weekly-toggle").checked;
  let pickupAt;
  let recurrence = null;
  if (recurring) {
    recurrence = validateRecurringPlan();
    if (recurrence.error) {
      setFormError(rideFormError, recurrence.error);
      return null;
    }
    pickupAt = recurrence.occurrences[0].at;
  } else {
    const candidates = easternWallTimeCandidates(pickupTimeInput.value);
    if (candidates.length !== 1) {
      const message = candidates.length === 0
        ? "That pickup time does not exist in Eastern Time because of the daylight-saving clock change. Choose another time."
        : "That pickup time is ambiguous during the Eastern Time daylight-saving change. Choose another time.";
      pickupTimeInput.setCustomValidity(message);
      pickupTimeInput.focus();
      setFormError(rideFormError, message);
      return null;
    }
    pickupAt = candidates[0];
    if (pickupAt.getTime() <= Date.now() + 5 * 60 * 1000) {
      pickupTimeInput.setCustomValidity("Choose a pickup time at least five minutes in the future.");
      pickupTimeInput.focus();
      setFormError(rideFormError, "Choose a pickup time at least five minutes in the future.");
      return null;
    }
  }

  const passengerCount = Number(passengersInput.value);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 6) {
    passengersInput.setCustomValidity("Choose between one and six passengers.");
    rideForm.reportValidity();
    setFormError(rideFormError, "Choose between one and six passengers.");
    return null;
  }

  return {
    pickup,
    stops,
    destination,
    pickupAt: pickupAt.toISOString(),
    passengerCount,
    recurrence,
  };
}

async function requestRouteAndFare(event) {
  event.preventDefault();
  if (!bookingApi) {
    setFormError(rideFormError, "Route estimates are not configured yet. Try again later.");
    return;
  }
  if (!navigator.onLine) {
    setFormError(rideFormError, "Connect to the internet to calculate a route and fare.");
    return;
  }
  const trip = validateTrip();
  if (!trip) return;

  clearBookingStatus();
  routeResult.hidden = true;
  routeEmpty.hidden = true;
  quoteDetails.hidden = true;
  quoteEmpty.hidden = true;
  quoteExpired.hidden = true;
  quoteError.hidden = true;
  routeError.hidden = true;
  routeStatus.textContent = "Finding the driving route and fare…";
  mapError.hidden = true;
  mapLoading.hidden = true;
  routeMap?.clearRoute();
  setRouteBusy(true);
  const sequence = ++quoteRequestSequence;
  currentTrip = trip;

  try {
    const result = await bookingApi.createRouteQuote({
      pickup: trip.pickup,
      stops: trip.stops,
      destination: trip.destination,
      pickupAt: trip.pickupAt,
      passengerCount: trip.passengerCount,
    });
    if (sequence !== quoteRequestSequence) return;
    const quote = result?.quote ?? result;
    if (!isValidQuote(quote)) throw new Error("The routing service returned an incomplete estimate. Please try again.");

    currentQuote = quote;
    renderFare(quote);
    routeEmpty.hidden = true;
    routeResult.hidden = false;
    text("#route-distance", `${quote.route.distanceMiles.toFixed(1)} mi`);
    text("#route-duration", `${Math.round(quote.route.durationMinutes)} min`);
    routeStatus.textContent = "Route and fare estimate ready.";
    scheduleQuoteExpiry(quote);

    if (routeMap) {
      mapLoading.hidden = false;
      try {
        await routeMap.setRoute({ ...quote.route, stops: quote.route.stops || quote.stops || [] });
        mapError.hidden = true;
      } catch {
        mapError.hidden = false;
      } finally {
        mapLoading.hidden = true;
      }
    } else {
      mapError.hidden = false;
    }
  } catch (error) {
    if (sequence !== quoteRequestSequence) return;
    currentQuote = null;
    routeError.hidden = false;
    quoteError.hidden = false;
    quoteEmpty.hidden = true;
    routeEmpty.hidden = true;
    const errorText = errorMessage(error, "We couldn’t find a route or calculate the fare. Please try again.");
    const message = $("#repeat-weekly-toggle").checked && /ambiguous|nonexistent|daylight.?saving|dst/i.test(errorText)
      ? "A selected weekly pickup time falls in an Eastern daylight-saving clock change and cannot be repeated. Choose another time."
      : errorText;
    routeError.textContent = message;
    quoteError.textContent = message;
    routeStatus.textContent = message;
  } finally {
    if (sequence === quoteRequestSequence) setRouteBusy(false);
  }
}

function bookingStatusCopy(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "accepted") return "accepted";
  if (normalized === "declined") return "declined";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "requested";
}

function updateRequestPaymentCopy() {
  const recurring = $("#repeat-weekly-toggle").checked;
  const checkoutCopy = stripePaymentsEnabled
    ? "Test-mode card Checkout is available after a driver accepts."
    : "Test-mode card Checkout is not configured in this preview yet.";
  text("#request-ride-note", recurring
    ? `Each date is a separate pending ride request. Drivers accept each date individually. ${checkoutCopy}`
    : `No payment is taken when you send a ride request. ${checkoutCopy}`);
}

function paymentStatusCopy(status) {
  const normalized = String(status || "").toLowerCase();
  const labels = {
    unpaid: "Complete card payment through test-mode Stripe Checkout to confirm this ride.",
    pending: "Your test payment is pending. Check your ride history for its latest status.",
    failed: "The test payment did not complete. You can try Checkout again.",
    expired: "This Checkout session expired. Start a new test payment.",
    paid: "Stripe confirmed this test payment.",
    partially_refunded: "Part of this test payment was refunded.",
    refunded: "This test payment was refunded.",
  };
  if (!stripePaymentsEnabled && ["unpaid", "pending", "failed", "expired", ""].includes(normalized)) {
    return "Test-mode card Checkout is not configured in this preview yet.";
  }
  return labels[normalized] || (normalized ? "Payment status is unavailable." : "Payment status is being checked.");
}

function canStartCheckout(booking) {
  const paymentStatus = String(booking?.paymentStatus || "").toLowerCase();
  return stripePaymentsEnabled &&
    signedInRole === "passenger" &&
    bookingStatusCopy(booking?.status) === "accepted" &&
    ["unpaid", "pending", "failed", "expired"].includes(paymentStatus);
}

function checkoutButtonLabel(paymentStatus) {
  const normalized = String(paymentStatus || "unpaid").toLowerCase();
  if (normalized === "pending") return "Continue test Checkout";
  if (normalized === "failed") return "Retry test payment";
  if (normalized === "expired") return "Start test Checkout";
  return "Pay by card (test mode)";
}

function setCheckoutButton(button, booking, { opening = false } = {}) {
  if (!button) return;
  button.hidden = !canStartCheckout(booking);
  button.textContent = opening ? "Opening secure Checkout…" : checkoutButtonLabel(booking?.paymentStatus);
  button.disabled = opening || !navigator.onLine || activeCheckoutBookingId === booking?.id;
}

function renderBookingStatus(booking, { focus = false } = {}) {
  currentBooking = booking;
  const status = bookingStatusCopy(booking?.status);
  bookingStatus.hidden = false;
  for (const name of ["requested", "accepted", "declined", "cancelled"]) {
    hidden(`#booking-${name}`, name !== status);
  }
  cancelRideButton.hidden = status !== "requested";
  cancelRideButton.disabled = isCancellingBooking || !navigator.onLine;
  const paymentMessage = paymentStatusCopy(booking?.paymentStatus);
  text("#booking-accepted-payment-status", status === "accepted" ? paymentMessage : "");
  setCheckoutButton(payForRideButton, booking, { opening: activeCheckoutBookingId === booking?.id });
  hidden("#checkout-error", true);
  text("#checkout-feedback", "");
  requestRideButton.hidden = true;
  $("#request-recurring-button").hidden = true;
  $("#signin-to-request-button").hidden = true;
  bookingStatusMessage.textContent =
    status === "accepted"
      ? `A driver accepted this ride request. ${paymentMessage}`
      : status === "declined"
        ? "No driver accepted this ride request."
        : status === "cancelled"
          ? "This ride request was cancelled."
          : "Your ride request is waiting for a driver.";
  const phone = booking.passengerPhone;
  const driverDetails = $("#booking-driver-details");
  if (driverDetails && status === "accepted") {
    driverDetails.textContent = phone
      ? `The driver can reach you at ${phone}.`
      : "Your ride is confirmed. Check your account email for follow-up.";
  }
  if (focus) {
    bookingStatus.setAttribute("tabindex", "-1");
    bookingStatus.focus();
  }
}

async function startCheckout({ bookingId, button, feedback }) {
  const booking = currentBooking?.id === bookingId ? currentBooking : historyBookings.get(bookingId);
  if (
    !bookingApi ||
    !bookingId ||
    !navigator.onLine ||
    activeCheckoutBookingId ||
    !canStartCheckout(booking)
  ) return;

  activeCheckoutBookingId = bookingId;
  setCheckoutButton(button, booking, { opening: true });
  hidden("#checkout-error", true);
  if (feedback) {
    feedback.hidden = false;
    feedback.textContent = "Opening secure test-mode Checkout…";
  }
  bookingStatusMessage.textContent = "Opening secure test-mode Stripe Checkout…";

  try {
    const result = await bookingApi.createCheckoutSession({ bookingId });
    const returnedPaymentStatus = String(result?.paymentStatus || "").toLowerCase();
    if (!result?.url && ["unpaid", "pending", "failed", "expired", "paid", "partially_refunded", "refunded"].includes(returnedPaymentStatus)) {
      const updatedBooking = { ...booking, paymentStatus: returnedPaymentStatus };
      historyBookings.set(bookingId, updatedBooking);
      if (currentBooking?.id === bookingId) renderBookingStatus(updatedBooking);
      const message = paymentStatusCopy(returnedPaymentStatus);
      if (feedback) feedback.textContent = message;
      bookingStatusMessage.textContent = message;
      await loadHistory({ quiet: true });
      return;
    }
    const checkoutUrl = new URL(result?.url || "");
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
      throw new Error("The payment service returned an invalid Checkout link. Please try again.");
    }
    window.location.assign(checkoutUrl.href);
  } catch (error) {
    const message = errorMessage(error, "We couldn’t open Checkout. Please try again.");
    if (feedback) feedback.textContent = message;
    const checkoutError = $("#checkout-error");
    if (checkoutError && button === payForRideButton) {
      checkoutError.textContent = message;
      checkoutError.hidden = false;
      if (feedback) feedback.textContent = "";
    }
    bookingStatusMessage.textContent = message;
  } finally {
    activeCheckoutBookingId = null;
    const latestBooking = currentBooking?.id === bookingId ? currentBooking : historyBookings.get(bookingId);
    setCheckoutButton(button, latestBooking);
  }
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function requestRide() {
  if (signedInRole !== "passenger") {
    showAuthView("Sign in with a passenger account to request this ride.");
    showAuthTab("login");
    return;
  }
  if (!currentQuote || !isValidQuote(currentQuote) || new Date(currentQuote.expiresAt).getTime() <= Date.now()) {
    setQuoteExpired();
    return;
  }
  if (!currentQuote.id || !quoteAllowsBooking(currentQuote) || !Number.isFinite(currentQuote.fare?.total) || hasUnpricedStops(currentQuote)) {
    setFormError(rideFormError, "Get an authenticated, fully priced estimate before requesting this ride.");
    return;
  }
  if (!navigator.onLine || isRequestingBooking) return;

  isRequestingBooking = true;
  requestRideButton.disabled = true;
  requestRideButton.textContent = "Sending request…";
  bookingStatusMessage.textContent = "Sending your ride request…";
  bookingIdempotencyKey ||= createIdempotencyKey();

  try {
    const result = await bookingApi.createBooking({
      quoteId: currentQuote.id,
      idempotencyKey: bookingIdempotencyKey,
    });
    const booking = result?.booking ?? result;
    if (!booking?.id) throw new Error("The ride request could not be confirmed. Please try again.");
    bookingIdempotencyKey = null;
    renderBookingStatus(booking, { focus: true });
    await loadHistory({ quiet: true });
  } catch (error) {
    bookingStatusMessage.textContent = errorMessage(error, "We couldn’t send your request. Please try again.");
    requestRideButton.disabled = false;
  } finally {
    isRequestingBooking = false;
    if (currentQuote) updateQuoteActions(currentQuote);
  }
}

async function requestRecurringRides() {
  if (signedInRole !== "passenger") {
    showAuthView("Sign in with a passenger account to request weekly rides.");
    showAuthTab("login");
    return;
  }
  const plan = validateRecurringPlan();
  if (plan.error) {
    setFormError(rideFormError, plan.error);
    return;
  }
  if (!currentQuote || !isValidQuote(currentQuote) || new Date(currentQuote.expiresAt).getTime() <= Date.now()) {
    setQuoteExpired();
    return;
  }
  if (!currentQuote.id || !quoteAllowsBooking(currentQuote) || !Number.isFinite(currentQuote.fare?.total) || hasUnpricedStops(currentQuote)) {
    setFormError(rideFormError, "Get an authenticated, fully priced estimate before requesting weekly rides.");
    return;
  }
  if (!navigator.onLine || isRequestingRecurring || !bookingApi) return;

  isRequestingRecurring = true;
  const button = $("#request-recurring-button");
  button.disabled = true;
  button.textContent = "Sending weekly requests…";
  bookingStatus.hidden = false;
  $("#recurring-booking-state").hidden = true;
  bookingStatusMessage.textContent = "Sending one ride request for each selected weekday…";
  bookingIdempotencyKey ||= createIdempotencyKey();
  try {
    const result = await bookingApi.createRecurringBooking({
      quoteId: currentQuote.id,
      idempotencyKey: bookingIdempotencyKey,
      weekdays: plan.weekdays,
      startDate: plan.startDate,
      endDate: plan.endDate,
      pickupTime: plan.pickupTime,
    });
    const bookings = Array.isArray(result?.bookings) ? result.bookings : [];
    if (!result?.series || bookings.length === 0) {
      throw new Error("The service did not confirm the weekly ride requests.");
    }
    bookingIdempotencyKey = null;
    currentRecurringSeries = result.series;
    $("#recurring-booking-state").hidden = false;
    const recurringPaymentCopy = stripePaymentsEnabled
      ? "Test-mode card Checkout is offered separately after each driver accepts."
      : "Test-mode card Checkout is not configured in this preview yet.";
    text("#recurring-booking-message", `${bookings.length} separate ride ${bookings.length === 1 ? "request was" : "requests were"} sent. Drivers accept each date individually. ${recurringPaymentCopy}`);
    bookingStatusMessage.textContent = "Weekly ride requests sent.";
    updateQuoteActions(currentQuote);
    bookingStatus.focus();
    await loadHistory({ quiet: true });
  } catch (error) {
    const message = errorMessage(error, "We couldn’t send the weekly ride requests. Please try again.");
    bookingStatusMessage.textContent = /ambiguous|nonexistent|daylight.?saving|dst/i.test(message)
      ? "A selected weekly pickup time falls in an Eastern daylight-saving clock change. Choose another time and get a new estimate."
      : message;
    button.disabled = false;
  } finally {
    isRequestingRecurring = false;
    button.textContent = "Request weekly rides";
    if (currentQuote) updateQuoteActions(currentQuote);
  }
}

async function cancelRide() {
  if (!currentBooking?.id || isCancellingBooking || !navigator.onLine) return;
  isCancellingBooking = true;
  cancelRideButton.disabled = true;
  bookingStatusMessage.textContent = "Cancelling the ride request…";
  try {
    const result = await bookingApi.cancelBooking({ bookingId: currentBooking.id });
    const booking = result?.booking ?? result;
    renderBookingStatus(booking, { focus: true });
    await loadHistory({ quiet: true });
  } catch (error) {
    bookingStatusMessage.textContent = errorMessage(error, "We couldn’t cancel this request. Refresh its status and try again.");
    cancelRideButton.disabled = false;
  } finally {
    isCancellingBooking = false;
    if (bookingStatusCopy(currentBooking?.status) === "requested") {
      cancelRideButton.disabled = !navigator.onLine;
    }
  }
}

function normalizeBookings(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.bookings)) return result.bookings;
  if (Array.isArray(result?.pending) || Array.isArray(result?.assigned)) {
    return [...(result.pending || []), ...(result.assigned || [])];
  }
  return [];
}

function historyStatus(status) {
  const labels = {
    pending: "Waiting for a driver",
    accepted: "Accepted",
    declined: "Not accepted",
    cancelled: "Cancelled",
  };
  return labels[String(status || "").toLowerCase()] || "Request status unavailable";
}

function historyPaymentCopy(booking) {
  if (bookingStatusCopy(booking?.status) !== "accepted") return "Payment starts only after a driver accepts.";
  return paymentStatusCopy(booking?.paymentStatus);
}

async function loadHistory({ quiet = false } = {}) {
  if (!bookingApi || isLoadingHistory || !navigator.onLine) {
    if (!navigator.onLine && !quiet) {
      hidden("#history-loading", true);
      hidden("#history-empty", false);
      text("#history-empty", "Connect to the internet to load your ride history.");
    }
    return;
  }
  isLoadingHistory = true;
  const list = $("#history-list");
  if (!quiet) {
    hidden("#history-loading", false);
    hidden("#history-empty", true);
    hidden("#history-error", true);
    list.hidden = true;
  }

  try {
    const result = await bookingApi.listBookings();
    const bookings = normalizeBookings(result).sort(
      (left, right) => new Date(right.createdAt || right.pickupAt).getTime() - new Date(left.createdAt || left.pickupAt).getTime(),
    );
    historyBookings.clear();
    for (const booking of bookings) {
      if (typeof booking.id !== "string" || !booking.id) continue;
      historyBookings.set(booking.id, booking);
    }
    if (currentBooking?.id) {
      const latestBooking = bookings.find((booking) => booking.id === currentBooking.id);
      if (latestBooking && (
        latestBooking.status !== currentBooking.status ||
        latestBooking.paymentStatus !== currentBooking.paymentStatus
      )) renderBookingStatus(latestBooking);
    }
    if (checkoutReturnBookingId && !checkoutReturnHandled) {
      checkoutReturnHandled = true;
      const returnedBooking = historyBookings.get(checkoutReturnBookingId);
      if (returnedBooking) {
        renderBookingStatus(returnedBooking);
        bookingStatusMessage.textContent = paymentStatusCopy(returnedBooking.paymentStatus);
      } else {
        bookingStatusMessage.textContent = "This ride is not available in your account. Check your ride history for its latest status.";
      }
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("checkout");
      cleanUrl.searchParams.delete("booking_id");
      window.history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }
    list.replaceChildren();
    const cancellableSeries = new Set();
    for (const booking of bookings) {
      const template = $("#ride-history-template");
      const fragment = template.content.cloneNode(true);
      fragment.querySelector("[data-history-pickup]").textContent = booking.pickupLabel || "Pickup unavailable";
      fragment.querySelector("[data-history-destination]").textContent = booking.destinationLabel || "Destination unavailable";
      const time = fragment.querySelector("[data-history-time]");
      time.dateTime = booking.pickupAt || "";
      time.textContent = formatPickupTime(booking.pickupAt);
      fragment.querySelector("[data-history-passengers]").textContent = `${booking.passengerCount} ${booking.passengerCount === 1 ? "passenger" : "passengers"}`;
      fragment.querySelector("[data-history-status]").textContent = historyStatus(booking.status);
      fragment.querySelector("[data-history-total]").textContent = formatCurrency(booking.fareTotal, booking.currency);
      fragment.querySelector("[data-history-payment]").textContent = historyPaymentCopy(booking);
      const payButton = fragment.querySelector("[data-history-pay]");
      payButton.hidden = !canStartCheckout(booking);
      payButton.disabled = !navigator.onLine || activeCheckoutBookingId === booking.id;
      payButton.textContent = checkoutButtonLabel(booking.paymentStatus);
      payButton.dataset.bookingId = booking.id;
      payButton.setAttribute("aria-label", `${checkoutButtonLabel(booking.paymentStatus)} for ride to ${booking.destinationLabel || "your destination"}`);
      const cancelSeriesButton = fragment.querySelector("[data-history-cancel-series]");
      if (booking.recurringSeriesId && String(booking.status).toLowerCase() === "pending" && !cancellableSeries.has(booking.recurringSeriesId)) {
        cancellableSeries.add(booking.recurringSeriesId);
        cancelSeriesButton.dataset.seriesId = booking.recurringSeriesId;
        cancelSeriesButton.hidden = false;
      }
      list.append(fragment);
    }
    hidden("#history-loading", true);
    hidden("#history-error", true);
    list.hidden = bookings.length === 0;
    hidden("#history-empty", bookings.length > 0);
    if (!bookings.length) text("#history-empty", "You don’t have any rides yet.");
  } catch (error) {
    hidden("#history-loading", true);
    hidden("#history-empty", true);
    hidden("#history-error", false);
    text("#history-error", errorMessage(error, "We couldn’t load your rides. Try again."));
  } finally {
    isLoadingHistory = false;
  }
}

async function handleCancelSeries(event) {
  const button = event.target.closest("[data-history-cancel-series]");
  const seriesId = button?.dataset.seriesId;
  if (!button || !seriesId || button.disabled || !navigator.onLine || !bookingApi) return;
  button.disabled = true;
  const feedback = button.parentElement.querySelector("[data-history-series-feedback]");
  if (feedback) {
    feedback.hidden = false;
    feedback.textContent = "Cancelling remaining weekly requests…";
  }
  try {
    await bookingApi.cancelRecurringBooking({ seriesId });
    if (feedback) feedback.textContent = "Remaining weekly requests cancelled.";
    await loadHistory({ quiet: true });
  } catch (error) {
    if (feedback) feedback.textContent = errorMessage(error, "We couldn’t cancel the remaining weekly requests. Refresh and try again.");
    button.disabled = false;
  }
}

async function handleHistoryPay(event) {
  const button = event.target.closest("[data-history-pay]");
  const bookingId = button?.dataset.bookingId;
  if (!button || !bookingId || button.disabled) return;
  const feedback = button.parentElement.querySelector("[data-history-payment-feedback]");
  await startCheckout({ bookingId, button, feedback });
}

async function handleHistoryAction(event) {
  if (event.target.closest("[data-history-pay]")) {
    await handleHistoryPay(event);
    return;
  }
  await handleCancelSeries(event);
}

function driverStatus(status) {
  const labels = {
    pending: "New request",
    accepted: "Accepted by you",
    declined: "Declined",
    cancelled: "Cancelled",
  };
  return labels[String(status || "").toLowerCase()] || "Status unavailable";
}

function driverActionAllowed(action, request) {
  return (action === "accept" || action === "decline") && request?.dataset.bookingStatus === "pending";
}

function renderDriverBookings(bookings) {
  const list = $("#driver-list");
  const template = $("#driver-request-template");
  list.replaceChildren();

  for (const booking of bookings) {
    const fragment = template.content.cloneNode(true);
    const request = fragment.querySelector("[data-driver-request]");
    request.dataset.bookingId = booking.id;
    request.dataset.bookingStatus = String(booking.status || "").toLowerCase();
    fragment.querySelector("[data-request-heading]").textContent =
      `${booking.pickupLabel || "Pickup"} → ${booking.destinationLabel || "Destination"}`;
    fragment.querySelector("[data-request-status]").textContent = driverStatus(booking.status);
    fragment.querySelector("[data-request-pickup]").textContent = booking.pickupLabel || "Pickup unavailable";
    fragment.querySelector("[data-request-destination]").textContent = booking.destinationLabel || "Destination unavailable";
    fragment.querySelector("[data-request-time]").textContent = formatPickupTime(booking.pickupAt);
    fragment.querySelector("[data-request-passengers]").textContent = `${booking.passengerCount} ${booking.passengerCount === 1 ? "passenger" : "passengers"}`;
    fragment.querySelector("[data-request-route]").textContent =
      `${Number(booking.distanceMiles).toFixed(1)} mi · ${Math.round(Number(booking.durationMinutes))} min`;
    fragment.querySelector("[data-request-total]").textContent = formatCurrency(booking.fareTotal, booking.currency);

    const feedback = fragment.querySelector("[data-request-feedback]");
    if (booking.passengerName || booking.passengerPhone) {
      const contact = [booking.passengerName, booking.passengerPhone].filter(Boolean).join(" · ");
      feedback.textContent = `Passenger contact: ${contact}`;
      feedback.hidden = false;
    }

    const isPending = String(booking.status).toLowerCase() === "pending";
    for (const button of fragment.querySelectorAll("[data-action='accept'], [data-action='decline']")) {
      button.hidden = !isPending;
    }
    list.append(fragment);
  }

  list.hidden = bookings.length === 0;
  hidden("#driver-empty", bookings.length > 0);
}

async function loadDriverQueue({ quiet = false } = {}) {
  if (!bookingApi || isLoadingDriverQueue || !navigator.onLine) {
    if (!navigator.onLine && !quiet) {
      hidden("#driver-loading", true);
      hidden("#driver-empty", false);
      text("#driver-empty", "Connect to the internet to load ride requests.");
    }
    return;
  }
  isLoadingDriverQueue = true;
  if (!quiet) {
    hidden("#driver-loading", false);
    hidden("#driver-empty", true);
    hidden("#driver-error", true);
    $("#driver-list").hidden = true;
  }

  try {
    const result = await bookingApi.listBookings();
    const bookings = normalizeBookings(result).filter((booking) =>
      ["pending", "accepted"].includes(String(booking.status || "").toLowerCase()),
    );
    renderDriverBookings(bookings);
    hidden("#driver-loading", true);
    hidden("#driver-error", true);
  } catch (error) {
    hidden("#driver-loading", true);
    hidden("#driver-empty", true);
    hidden("#driver-error", false);
    text("#driver-error", errorMessage(error, "We couldn’t load requests. Try again."));
  } finally {
    isLoadingDriverQueue = false;
  }
}

async function loadDriverAvailability() {
  if (!bookingApi || isLoadingAvailability || !navigator.onLine || signedInRole !== "driver") return;
  isLoadingAvailability = true;
  hidden("#availability-loading", false);
  hidden("#availability-error", true);
  const form = $("#availability-form");
  for (const input of form.querySelectorAll("input, button")) input.disabled = true;
  try {
    const result = await bookingApi.getDriverAvailability();
    const availability = Array.isArray(result) ? result : result?.availability;
    if (!Array.isArray(availability)) throw new Error("The availability schedule could not be read.");
    const byDay = new Map(availability.map((item) => [Number(item.dayOfWeek), item]));
    for (let day = 1; day <= 7; day += 1) {
      const row = $(`[data-availability-day="${day}"]`);
      const enabled = byDay.has(day);
      const checkbox = row.querySelector('input[name="availability-day"]');
      const start = row.querySelector('input[name="availability-start"]');
      const end = row.querySelector('input[name="availability-end"]');
      checkbox.checked = enabled;
      start.disabled = !enabled;
      end.disabled = !enabled;
      start.required = enabled;
      end.required = enabled;
      start.value = enabled ? String(byDay.get(day).startTime || "").slice(0, 5) : "";
      end.value = enabled ? String(byDay.get(day).endTime || "").slice(0, 5) : "";
    }
    hidden("#availability-empty", availability.length > 0);
  } catch (error) {
    hidden("#availability-error", false);
    text("#availability-error", errorMessage(error, "We couldn’t load your availability. Try again."));
  } finally {
    hidden("#availability-loading", true);
    for (const input of form.querySelectorAll("input, button")) input.disabled = false;
    for (const row of $$(".availability-day")) {
      const active = row.querySelector('input[name="availability-day"]').checked;
      row.querySelectorAll('input[type="time"]').forEach((input) => {
        input.disabled = !active;
        input.required = active;
      });
    }
    isLoadingAvailability = false;
  }
}

async function saveDriverAvailability(event) {
  event.preventDefault();
  if (signedInRole !== "driver" || !bookingApi || !navigator.onLine || isSavingAvailability) return;
  const rows = $$(".availability-day");
  const availability = [];
  setFormError($("#availability-form-error"), "");
  for (const row of rows) {
    const day = Number(row.dataset.availabilityDay);
    const checkbox = row.querySelector('input[name="availability-day"]');
    const start = row.querySelector('input[name="availability-start"]');
    const end = row.querySelector('input[name="availability-end"]');
    start.setCustomValidity("");
    end.setCustomValidity("");
    if (!checkbox.checked) continue;
    if (!start.value || !end.value) {
      (start.value ? end : start).setCustomValidity("Choose both a start and end time.");
      (start.value ? end : start).focus();
      setFormError($("#availability-form-error"), `${row.querySelector("span").textContent} needs a start and end time.`);
      return;
    }
    if (end.value <= start.value) {
      end.setCustomValidity("End time must be later than start time. Overnight availability is not supported.");
      end.focus();
      setFormError($("#availability-form-error"), `${row.querySelector("span").textContent} must end later than it starts. Overnight windows aren’t supported.`);
      return;
    }
    availability.push({ dayOfWeek: day, startTime: start.value, endTime: end.value });
  }

  isSavingAvailability = true;
  $("#save-availability-button").disabled = true;
  text("#availability-save-status", "Saving your weekly availability…");
  try {
    const result = await bookingApi.saveDriverAvailability({ availability });
    const saved = Array.isArray(result) ? result : result?.availability;
    if (!Array.isArray(saved)) throw new Error("The service did not confirm the availability schedule.");
    text("#availability-save-status", "Availability saved.");
    hidden("#availability-empty", saved.length > 0);
    hidden("#availability-error", true);
  } catch (error) {
    setFormError($("#availability-form-error"), errorMessage(error, "We couldn’t save your availability. Try again."));
    text("#availability-save-status", "");
  } finally {
    isSavingAvailability = false;
    $("#save-availability-button").disabled = !navigator.onLine;
  }
}

async function handleDriverAction(event) {
  const button = event.target.closest("[data-action='accept'], [data-action='decline']");
  const request = button?.closest("[data-driver-request]");
  const bookingId = request?.dataset.bookingId;
  if (!button || !bookingId || button.disabled || !navigator.onLine) return;
  const action = button.dataset.action;
  if (!driverActionAllowed(action, request)) return;
  const feedback = request.querySelector("[data-request-feedback]");
  const buttons = [...request.querySelectorAll("[data-action]")];
  buttons.forEach((item) => (item.disabled = true));
  feedback.hidden = false;
  feedback.textContent = action === "accept" ? "Accepting request…" : "Declining request…";

  try {
    await bookingApi.respondToBooking({ bookingId, decision: action });
    text("#driver-action-status", action === "accept" ? "Ride accepted." : "Ride declined.");
    await loadDriverQueue({ quiet: true });
  } catch (error) {
    feedback.textContent = errorMessage(error, "We couldn’t update this request. Refresh the list and try again.");
    buttons.forEach((item) => {
      item.disabled = !navigator.onLine || !driverActionAllowed(item.dataset.action, request);
    });
  }
}

async function synchronizeSession(session) {
  if (isPasswordRecovery) {
    showPasswordRecoveryPanel();
    return;
  }
  const sequence = ++sessionSequence;
  if (!session?.access_token) {
    clearPassengerSessionState();
    if (currentQuote?.id) invalidateRouteAndQuote("You’re signed out. Get a new public estimate or sign in to request a ride.");
    showPublicPlanner();
    return;
  }

  appShell.dataset.authState = "checking-account";
  try {
    const result = await bookingApi.getProfile();
    if (sequence !== sessionSequence) return;
    const profile = result?.profile ?? result;
    showRoleView(profile, session.user?.email);
    if (profile.role === "passenger") void loadHistory({ quiet: true });
  } catch (error) {
    if (sequence !== sessionSequence) return;
    const message = errorMessage(error, "We couldn’t verify this account.");
    await authClient.auth.signOut();
    showAuthView(message);
  }
}

async function loadPublicPricing() {
  hidden("#pricing-loading", false);
  hidden("#pricing-error", true);
  hidden("#pricing-retry-button", true);
  try {
    const result = await bookingApi.getPricing();
    const rates = result?.rates;
    if (
      result?.currency !== "USD" ||
      result?.provisional !== true ||
      !rates ||
      ![rates.baseFare, rates.perMile, rates.perMinute, rates.minimumFare, rates.bookingFee].every(Number.isFinite) ||
      !(rates.stopFeePerStop === null || Number.isFinite(rates.stopFeePerStop))
    ) throw new Error("The rate schedule is incomplete.");
    text("#rate-base", formatCurrency(rates.baseFare, result.currency));
    text("#rate-mile", `${formatCurrency(rates.perMile, result.currency)} / mile`);
    text("#rate-minute", `${formatCurrency(rates.perMinute, result.currency)} / minute`);
    text("#rate-minimum", formatCurrency(rates.minimumFare, result.currency));
    text("#rate-booking", formatCurrency(rates.bookingFee, result.currency));
    hidden("#rate-stop-row", false);
    text("#rate-stop", rates.stopFeePerStop === null ? "Not set" : formatCurrency(rates.stopFeePerStop, result.currency));
    hidden("#pricing-list", false);
  } catch (error) {
    hidden("#pricing-list", true);
    hidden("#pricing-error", false);
    hidden("#pricing-retry-button", false);
    text("#pricing-error", errorMessage(error, "Sample rates are unavailable right now."));
  } finally {
    hidden("#pricing-loading", true);
  }
}

async function initializeApplication() {
  setMinimumPickupTime();
  showAuthTab("login");
  syncScheduleMode();
  showPublicPlanner();
  for (const kind of addressKinds) setupAutocomplete(kind);
  try {
    bookingApi = createBookingApi(null);
    void loadPublicPricing();
  } catch (error) {
    bookingApi = null;
    authSetupError = errorMessage(error, "Steadlane’s public route service is not ready yet.");
    text("#pricing-error", authSetupError);
    hidden("#pricing-error", false);
    hidden("#pricing-retry-button", false);
    signInButton.disabled = true;
  }
  try {
    routeMap = routeMapElement ? createRouteMap(routeMapElement) : null;
  } catch {
    routeMap = null;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {
      // The online booking experience still works when offline installation is unavailable.
    });
  }
  window.addEventListener("online", updateNetworkState);
  window.addEventListener("offline", updateNetworkState);
  updateNetworkState();

  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    let configuration;
    try {
      configuration = await response.json();
    } catch {
      configuration = null;
    }
    if (!response.ok || !configuration?.supabaseUrl || !configuration?.supabasePublishableKey) {
      throw new Error(configuration?.error?.message || "Steadlane account setup is not complete yet.");
    }
    stripePaymentsEnabled = configuration.stripePaymentsEnabled === true;
    updateRequestPaymentCopy();
    if (currentQuote) updateQuoteActions(currentQuote);
    authClient = createAuthClient(configuration);
    bookingApi = createBookingApi(authClient);
  } catch (error) {
    authClient = null;
    stripePaymentsEnabled = false;
    try {
      bookingApi = createBookingApi(null);
    } catch {
      bookingApi = null;
    }
    const message = errorMessage(error, "Steadlane account setup is not complete yet.");
    authSetupError = `${message} Ask the Steadlane team to finish account setup.`;
    updateRequestPaymentCopy();
    setAuthMessage(authSetupError, "error");
    signInButton.disabled = true;
    for (const form of [$("#login-form"), $("#signup-form")]) {
      for (const input of form.querySelectorAll("input, button")) input.disabled = true;
    }
    $("#forgot-password-button").disabled = true;
    for (const input of $("#password-recovery-form").querySelectorAll("input, button")) input.disabled = true;
  }

  if (!authClient) {
    showPublicPlanner();
    return;
  }

  const { data } = authClient.auth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => {
      if (_event === "PASSWORD_RECOVERY") {
        isPasswordRecovery = true;
        showPasswordRecoveryPanel({ focus: true });
        return;
      }
      void synchronizeSession(session);
    });
  });
  authSubscription = data.subscription;
  try {
    const { data: sessionData, error: sessionError } = await authClient.auth.getSession();
    if (sessionError) throw sessionError;
    await synchronizeSession(sessionData.session);
  } catch (error) {
    showPublicPlanner(errorMessage(error, "We couldn’t restore your sign-in. Please sign in again."));
  }
}

function updateNetworkState() {
  offlineNotice.hidden = navigator.onLine;
  if (currentQuote && !currentBooking && !currentRecurringSeries) {
    updateQuoteActions(currentQuote);
  }
  const routeSubmit = rideForm.querySelector("button[type='submit']");
  routeSubmit.disabled = !navigator.onLine || rideForm.getAttribute("aria-busy") === "true";
  cancelRideButton.disabled = !navigator.onLine || isCancellingBooking;
  setCheckoutButton(payForRideButton, currentBooking, { opening: activeCheckoutBookingId === currentBooking?.id });
  signInButton.disabled = !navigator.onLine || Boolean(authSetupError) || !authClient;
  if (!isSavingAvailability) $("#save-availability-button").disabled = !navigator.onLine;
  for (const button of $$("#driver-list [data-action]")) {
    const request = button.closest("[data-driver-request]");
    button.disabled = !navigator.onLine || !driverActionAllowed(button.dataset.action, request);
  }
  for (const button of $$("#history-list [data-history-cancel-series]")) {
    button.disabled = !navigator.onLine;
  }
  for (const button of $$("#history-list [data-history-pay]")) {
    button.disabled = !navigator.onLine || activeCheckoutBookingId === button.dataset.bookingId;
  }
  if (navigator.onLine) {
    if (!passengerView.hidden && (!$("#passenger-history-panel").hidden || currentBooking)) {
      void loadHistory({ quiet: true });
    }
    if (!driverView.hidden) void loadDriverQueue({ quiet: true });
    if (!driverView.hidden) void loadDriverAvailability();
  }
}

for (const button of $$("[data-auth-mode]")) {
  button.addEventListener("click", () => showAuthTab(button.dataset.authMode));
  button.addEventListener("keydown", (event) => {
    const tabs = $$("[data-auth-mode]");
    const currentIndex = tabs.indexOf(button);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    showAuthTab(nextTab.dataset.authMode);
    nextTab.focus();
  });
}

function syncScheduleMode() {
  const recurring = $("#repeat-weekly-toggle").checked;
  $("#pickup-time-field").hidden = recurring;
  pickupTimeInput.required = !recurring;
  $("#recurrence-options").hidden = !recurring;
  updateRequestPaymentCopy();
  if (currentQuote) updateQuoteActions(currentQuote);
}

for (const button of $$('[data-action="signin"]')) {
  button.addEventListener("click", () => {
    if (button.disabled || !authClient) return;
    showAuthView("Your trip plan is saved on this page. Sign in to refresh the estimate and request it.");
    showAuthTab("login");
    loginEmailInput.focus();
  });
}

$("#auth-back-to-planner").addEventListener("click", () => {
  showPublicPlanner();
  pickupInput.focus();
});

$("#pricing-retry-button").addEventListener("click", () => {
  if (bookingApi) void loadPublicPricing();
});

$("#add-stop-button").addEventListener("click", () => {
  const next = stopIndexes.find((index) => $(`#stop-field-${index}`).hidden);
  if (!next) return;
  $(`#stop-field-${next}`).hidden = false;
  $("#add-stop-button").hidden = stopIndexes.every((index) => !$(`#stop-field-${index}`).hidden);
  addressInput(`stop-${next}`).focus();
});

for (const index of stopIndexes) {
  $(`[data-remove-stop="${index}"]`).addEventListener("click", () => {
    const kind = `stop-${index}`;
    addressInput(kind).value = "";
    selectedPlaces[kind] = null;
    clearAutocomplete(kind);
    $(`#stop-field-${index}`).hidden = true;
    $("#add-stop-button").hidden = false;
    invalidateRouteAndQuote("Trip details changed. Get a new route and fare before requesting a ride.");
  });
}

$("#repeat-weekly-toggle").addEventListener("change", () => {
  syncScheduleMode();
  invalidateRouteAndQuote("Schedule changed. Get a new route and fare before requesting a ride.");
  setFormError(rideFormError, "");
});

$("#forgot-password-button").addEventListener("click", async () => {
  const button = $("#forgot-password-button");
  const loading = $("#password-reset-loading");
  const errorOutput = $("#password-reset-error");
  const successOutput = $("#password-reset-success");
  setFormError(errorOutput, "");
  successOutput.hidden = true;
  if (!loginEmailInput.reportValidity()) return;

  button.disabled = true;
  loading.hidden = false;
  try {
    const { error } = await authClient.auth.resetPasswordForEmail(
      loginEmailInput.value.trim(),
      { redirectTo: `${window.location.origin}/` },
    );
    if (error) throw error;
    successOutput.hidden = false;
  } catch (error) {
    setFormError(errorOutput, "We couldn’t send a reset link. Try again.");
  } finally {
    loading.hidden = true;
    button.disabled = false;
  }
});

$("#password-recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const passwordInput = $("#recovery-password");
  const confirmInput = $("#recovery-password-confirm");
  const errorOutput = $("#password-recovery-error");
  const successOutput = $("#password-recovery-success");
  const loading = $("#password-recovery-loading");
  setFormError(errorOutput, "");
  successOutput.hidden = true;
  confirmInput.setCustomValidity(
    passwordInput.value === confirmInput.value ? "" : "Enter the same password in both fields.",
  );
  if (!form.reportValidity()) return;

  setAuthFormBusy(form, true);
  loading.hidden = false;
  try {
    const { error } = await authClient.auth.updatePassword(passwordInput.value);
    if (error) throw error;
    isPasswordRecovery = true;
    successOutput.hidden = false;
    passwordInput.value = "";
    confirmInput.value = "";
    for (const input of [passwordInput, confirmInput]) input.disabled = true;
    $("#password-recovery-submit").hidden = true;
    setAuthMessage("Password updated. Use Back to sign in with your new password.", "success");
  } catch (error) {
    setFormError(errorOutput, errorMessage(error, "We couldn’t update your password. Request a new reset link and try again."));
  } finally {
    loading.hidden = true;
    form.setAttribute("aria-busy", "false");
  }
});

$("#password-recovery-back").addEventListener("click", () => {
  const form = $("#password-recovery-form");
  form.reset();
  for (const input of form.querySelectorAll("input")) input.disabled = false;
  $("#password-recovery-submit").hidden = false;
  setFormError($("#password-recovery-error"), "");
  $("#password-recovery-success").hidden = true;
  setAuthMessage("");
  hidePasswordRecoveryPanel({ focus: true });
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormError($("#login-error"), "");
  if (!event.currentTarget.reportValidity()) return;
  setAuthFormBusy(event.currentTarget, true);
  text("#login-status", "Signing in…");
  try {
    const formData = new FormData(event.currentTarget);
    const { error } = await authClient.auth.signInWithPassword({
      email: String(formData.get("email")).trim(),
      password: String(formData.get("password")),
    });
    if (error) throw error;
    event.currentTarget.reset();
    text("#login-status", "Signed in. Loading your Steadlane account…");
  } catch (error) {
    setFormError($("#login-error"), errorMessage(error, "We couldn’t sign you in. Check your email and password."));
    text("#login-status", "");
  } finally {
    setAuthFormBusy(event.currentTarget, false);
  }
});

$("#signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormError($("#signup-error"), "");
  if (!event.currentTarget.reportValidity()) return;
  setAuthFormBusy(event.currentTarget, true);
  text("#signup-status", "Creating your passenger account…");
  try {
    const formData = new FormData(event.currentTarget);
    const fullName = String(formData.get("fullName") || "").trim();
    const phone = String(formData.get("phone") || "").trim();
    const { data, error } = await authClient.auth.signUp({
      email: String(formData.get("email")).trim(),
      password: String(formData.get("password")),
      options: {
        data: { full_name: fullName, ...(phone ? { phone } : {}) },
        emailRedirectTo: `${window.location.origin}/`,
      },
    });
    if (error) throw error;
    event.currentTarget.reset();
    text(
      "#signup-status",
      data.session
        ? "Your account is ready. Loading your ride dashboard…"
        : "Check your email for a confirmation link. If it doesn’t arrive, account email delivery still needs to be configured.",
    );
  } catch (error) {
    setFormError($("#signup-error"), errorMessage(error, "We couldn’t create your account. Please try again."));
    text("#signup-status", "");
  } finally {
    setAuthFormBusy(event.currentTarget, false);
  }
});

$("#sign-out-button").addEventListener("click", async () => {
  if (!authClient) return;
  const button = $("#sign-out-button");
  button.disabled = true;
  try {
    const { error } = await authClient.auth.signOut();
    if (error) throw error;
    showPublicPlanner("You are signed out. Your trip plan is still here.");
  } catch (error) {
    setAuthMessage(errorMessage(error, "We couldn’t sign you out. Try again."), "error");
  } finally {
    button.disabled = false;
  }
});

for (const button of [...passengerNavButtons, ...$$(".local-nav__button")]) {
  button?.addEventListener("click", () => showPassengerPanel(button.dataset.passengerPanelTarget));
}

$("#nav-driver").addEventListener("click", () => {
  if (driverNavButton.hidden) return;
  showDriverView();
});

rideForm.addEventListener("submit", requestRouteAndFare);
rideForm.addEventListener("input", (event) => {
  if (addressKinds.some((kind) => event.target === addressInput(kind))) return;
  invalidateRouteAndQuote("Trip details changed. Get a new route and fare before requesting a ride.");
  setFormError(rideFormError, "");
});
rideForm.addEventListener("change", (event) => {
  event.target.setCustomValidity?.("");
  if (addressKinds.some((kind) => event.target === addressInput(kind))) return;
  invalidateRouteAndQuote("Trip details changed. Get a new route and fare before requesting a ride.");
  setFormError(rideFormError, "");
});
rideForm.addEventListener("reset", () => {
  window.setTimeout(() => {
    selectedPlaces.pickup = null;
    selectedPlaces.destination = null;
    for (const kind of addressKinds) {
      selectedPlaces[kind] = null;
      clearAutocomplete(kind);
    }
    for (const index of stopIndexes) $(`#stop-field-${index}`).hidden = true;
    $("#add-stop-button").hidden = false;
    syncScheduleMode();
    invalidateRouteAndQuote("Enter your pickup and destination to get a route and fare estimate.");
    setMinimumPickupTime();
  }, 0);
});

requestRideButton.addEventListener("click", () => void requestRide());
$("#request-recurring-button").addEventListener("click", () => void requestRecurringRides());
cancelRideButton.addEventListener("click", () => void cancelRide());
payForRideButton.addEventListener("click", () => void startCheckout({
  bookingId: currentBooking?.id,
  button: payForRideButton,
  feedback: $("#checkout-feedback"),
}));
$("#driver-list").addEventListener("click", (event) => void handleDriverAction(event));
$("#history-list").addEventListener("click", (event) => void handleHistoryAction(event));
$("#availability-form").addEventListener("submit", (event) => void saveDriverAvailability(event));
for (const checkbox of $$(".availability-day input[name='availability-day']")) {
  checkbox.addEventListener("change", () => {
    const row = checkbox.closest(".availability-day");
    for (const input of row.querySelectorAll("input[type='time']")) {
      input.disabled = !checkbox.checked;
      input.required = checkbox.checked;
      if (!checkbox.checked) input.value = "";
    }
  });
}

window.addEventListener("focus", () => {
  if (!passengerView.hidden && (!$("#passenger-history-panel").hidden || currentBooking)) {
    void loadHistory({ quiet: true });
  }
  if (!driverView.hidden) void loadDriverQueue({ quiet: true });
});

window.setInterval(() => {
  if (!navigator.onLine) return;
  if (!passengerView.hidden && currentBooking && (
    bookingStatusCopy(currentBooking.status) === "requested" ||
    (bookingStatusCopy(currentBooking.status) === "accepted" && !["paid", "partially_refunded", "refunded"].includes(currentBooking.paymentStatus))
  )) {
    void loadHistory({ quiet: true });
  }
  if (!driverView.hidden) void loadDriverQueue({ quiet: true });
}, 30_000);

window.addEventListener("beforeunload", () => {
  authSubscription?.unsubscribe();
  routeMap?.destroy();
  clearTimeout(quoteExpiryTimer);
  for (const state of Object.values(autocomplete)) {
    clearTimeout(state.timer);
    state.controller?.abort();
  }
});

void initializeApplication();
