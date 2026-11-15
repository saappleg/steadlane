import { DEFAULT_RATES, calculateFareBreakdown } from "./pricing.js";

const form = document.querySelector("#ride-form");
const pickupInput = document.querySelector("#pickup");
const destinationInput = document.querySelector("#destination");
const pickupTimeInput = document.querySelector("#pickup-time");
const passengersInput = document.querySelector("#passengers");
const distanceInput = document.querySelector("#distance");
const durationInput = document.querySelector("#duration");
const formError = document.querySelector("#form-error");
const estimateEmpty = document.querySelector("#estimate-empty");
const estimateDetails = document.querySelector("#estimate-details");
const estimateStatus = document.querySelector("#estimate-status");
const reviewPanel = document.querySelector("#trip-review");
const reviewHeading = document.querySelector("#review-heading");
const rateSummary = document.querySelector("#rate-summary");

const fareOutputs = {
  total: document.querySelector("#estimate-total"),
  base: document.querySelector("#fare-base"),
  distance: document.querySelector("#fare-distance"),
  duration: document.querySelector("#fare-duration"),
  minimumAdjustmentRow: document.querySelector("#minimum-adjustment-row"),
  minimumAdjustment: document.querySelector("#fare-minimum-adjustment"),
  bookingFee: document.querySelector("#fare-booking-fee"),
  breakdownTotal: document.querySelector("#fare-total"),
};

const reviewOutputs = {
  pickup: document.querySelector("#review-pickup"),
  destination: document.querySelector("#review-destination"),
  time: document.querySelector("#review-time"),
  passengers: document.querySelector("#review-passengers"),
  route: document.querySelector("#review-route"),
  total: document.querySelector("#review-total"),
};

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

let currentTrip = null;
let currentFare = null;

function formatCurrency(value) {
  return currency.format(value);
}

function describeSampleRates() {
  return `${formatCurrency(DEFAULT_RATES.baseFare)} base, ${formatCurrency(DEFAULT_RATES.perMile)} per mile, ${formatCurrency(DEFAULT_RATES.perMinute)} per minute, ${formatCurrency(DEFAULT_RATES.minimumFare)} minimum subtotal, and ${formatCurrency(DEFAULT_RATES.bookingFee)} booking fee`;
}

function formatPickupTime(value) {
  const selectedTime = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(selectedTime);
}

function setMinimumPickupTime() {
  const localNow = new Date();
  localNow.setMinutes(localNow.getMinutes() - localNow.getTimezoneOffset());
  pickupTimeInput.min = localNow.toISOString().slice(0, 16);
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = "";
}

function setFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function resetEstimate(message = "Enter your trip and route details to see a sample fare breakdown here.") {
  currentTrip = null;
  currentFare = null;
  estimateEmpty.textContent = message;
  estimateEmpty.hidden = false;
  estimateDetails.hidden = true;
  reviewPanel.hidden = true;
  estimateStatus.textContent = "";
}

function collectTrip() {
  const distanceMiles = Number(distanceInput.value);
  const durationMinutes = Number(durationInput.value);
  const passengerCount = Number(passengersInput.value);
  const pickupTime = new Date(pickupTimeInput.value);

  if (!Number.isFinite(distanceMiles) || distanceMiles < 0.1 || distanceMiles > 2500) {
    distanceInput.setCustomValidity("Enter a route distance from 0.1 to 2,500 miles.");
    form.reportValidity();
    setFormError("Check the route distance and enter a value from 0.1 to 2,500 miles.");
    return null;
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    durationInput.setCustomValidity("Enter a drive time from 1 to 1,440 minutes.");
    form.reportValidity();
    setFormError("Check the drive time and enter a value from 1 to 1,440 minutes.");
    return null;
  }

  if (!Number.isFinite(passengerCount) || passengerCount < 1 || passengerCount > 6) {
    passengersInput.setCustomValidity("Choose between one and six passengers.");
    form.reportValidity();
    setFormError("Choose between one and six passengers.");
    return null;
  }

  if (!Number.isFinite(pickupTime.getTime()) || pickupTime.getTime() < Date.now()) {
    pickupTimeInput.setCustomValidity("Choose a pickup time in the future.");
    form.reportValidity();
    setFormError("Choose a pickup time in the future.");
    return null;
  }

  const pickup = pickupInput.value.trim();
  const destination = destinationInput.value.trim();
  if (!pickup || !destination) {
    const input = pickup ? destinationInput : pickupInput;
    input.setCustomValidity("Enter a location.");
    form.reportValidity();
    setFormError("Enter both a pickup location and a destination.");
    return null;
  }

  if (pickup.toLocaleLowerCase() === destination.toLocaleLowerCase()) {
    destinationInput.setCustomValidity("Choose a different destination from the pickup.");
    form.reportValidity();
    setFormError("Pickup and destination must be different locations.");
    return null;
  }

  return {
    pickup,
    destination,
    pickupTime: pickupTimeInput.value,
    passengerCount,
    distanceMiles,
    durationMinutes,
  };
}

function renderFare(trip, fare) {
  fareOutputs.total.textContent = formatCurrency(fare.total);
  fareOutputs.base.textContent = formatCurrency(fare.baseFare);
  fareOutputs.distance.textContent = `${trip.distanceMiles.toFixed(1)} mi × ${formatCurrency(DEFAULT_RATES.perMile)} = ${formatCurrency(fare.distanceCharge)}`;
  fareOutputs.duration.textContent = `${trip.durationMinutes} min × ${formatCurrency(DEFAULT_RATES.perMinute)} = ${formatCurrency(fare.durationCharge)}`;
  fareOutputs.minimumAdjustmentRow.hidden = fare.minimumAdjustment === 0;
  fareOutputs.minimumAdjustment.textContent = formatCurrency(fare.minimumAdjustment);
  fareOutputs.bookingFee.textContent = formatCurrency(fare.bookingFee);
  fareOutputs.breakdownTotal.textContent = formatCurrency(fare.total);
  estimateEmpty.hidden = true;
  estimateDetails.hidden = false;
  estimateStatus.textContent = `Illustrative fare estimate: ${formatCurrency(fare.total)}. Review the sample fare notice before continuing.`;
}

function renderReview(trip, fare) {
  reviewOutputs.pickup.textContent = trip.pickup;
  reviewOutputs.destination.textContent = trip.destination;
  reviewOutputs.time.textContent = formatPickupTime(trip.pickupTime);
  reviewOutputs.passengers.textContent = `${trip.passengerCount} ${trip.passengerCount === 1 ? "passenger" : "passengers"}`;
  reviewOutputs.route.textContent = `${trip.distanceMiles.toFixed(1)} mi · ${trip.durationMinutes} min`;
  reviewOutputs.total.textContent = formatCurrency(fare.total);
  reviewPanel.hidden = false;
  reviewHeading.focus();
}

function clearCustomValidity(event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    event.target.setCustomValidity("");
  }
}

form.addEventListener("input", (event) => {
  clearCustomValidity(event);
  clearFormError();
  if (currentFare) {
    resetEstimate("Your trip changed. Get a new estimate before reviewing it.");
  }
});

form.addEventListener("change", (event) => {
  clearCustomValidity(event);
  clearFormError();
  if (currentFare) {
    resetEstimate("Your trip changed. Get a new estimate before reviewing it.");
  }
});

form.addEventListener(
  "invalid",
  (event) => {
    if (!formError.hidden) return;
    const field = event.target;
    const label = field.labels?.[0]?.textContent.trim() || "Trip detail";
    const reason = field.validationMessage || "Check the highlighted field.";
    setFormError(`${label}: ${reason}`);
  },
  true,
);

form.addEventListener("reset", () => {
  clearFormError();
  resetEstimate();
  setMinimumPickupTime();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearFormError();

  if (!form.checkValidity()) {
    form.reportValidity();
    setFormError("Check the highlighted fields and enter valid trip details.");
    return;
  }

  const trip = collectTrip();
  if (!trip) return;

  try {
    const fare = calculateFareBreakdown(trip);
    currentTrip = trip;
    currentFare = fare;
    reviewPanel.hidden = true;
    renderFare(trip, fare);
  } catch (error) {
    const message = error instanceof Error ? error.message : "We could not calculate this estimate.";
    setFormError(message);
    estimateStatus.textContent = message;
  }
});

document.querySelector("#review-button").addEventListener("click", () => {
  if (currentTrip && currentFare) {
    renderReview(currentTrip, currentFare);
  }
});

document.querySelector("#edit-trip-button").addEventListener("click", () => {
  reviewPanel.hidden = true;
  pickupInput.focus();
});

for (const input of [pickupInput, destinationInput]) {
  input.addEventListener("input", () => {
    if (input.value.trim()) input.setCustomValidity("");
  });
}

setMinimumPickupTime();
rateSummary.textContent = describeSampleRates();
