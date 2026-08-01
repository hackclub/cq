import { splitList } from "./utils.js";

function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isGithubRepo(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return ["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) && parts.length >= 2;
  } catch {
    return false;
  }
}

export function projectInput(body = {}) {
  const allowedTypes = ["antenna", "radio-electronics", "sdr", "digital-mode", "satellite", "propagation", "station-tooling", "other"];
  return {
    title: text(body.title, 80),
    description: text(body.description, 800),
    repoUrl: text(body.repo_url, 500),
    demoUrl: text(body.demo_url, 500),
    thumbnailUrl: text(body.thumbnail_url, 500),
    hackatimeProjects: splitList(body.hackatime_projects).slice(0, 20),
    evidence: ["commits", "elapsed", "devlog"].filter((key) => {
      const selected = Array.isArray(body.evidence) ? body.evidence : [body.evidence];
      return selected.includes(key);
    }),
    track: body.track === "software" ? "software" : "hardware",
    projectType: allowedTypes.includes(body.project_type) ? body.project_type : "",
    radioRelevance: text(body.radio_relevance, 800),
    countryCode: text(body.country_code, 10).toUpperCase(),
    licenseGoal: text(body.license_goal, 120),
    callsign: text(body.callsign, 30).toUpperCase(),
    aiStatement: text(body.ai_statement, 500),
    tags: splitList(body.tags).slice(0, 10),
    isUpdate: body.is_update === "1",
    updateMessage: text(body.update_message, 2000),
  };
}

export function validateProject(input, { forSubmission = false, journalMinutes = 0 } = {}) {
  const errors = [];
  if (input.title.length < 2) errors.push("Give the project a name of at least 2 characters.");
  if (input.description.length < 20) errors.push("Describe the project in at least 20 characters.");
  if (!isGithubRepo(input.repoUrl)) errors.push("Add a public GitHub repository URL.");
  if (!input.projectType) errors.push("Choose the kind of ham-radio project you are making.");
  if (input.radioRelevance.length < 40) {
    errors.push("Explain in at least 40 characters how the project directly relates to ham radio.");
  }
  if (!input.countryCode) errors.push("Choose the country or territory where you live.");

  if (forSubmission) {
    if (!isHttpUrl(input.thumbnailUrl)) errors.push("Add a public thumbnail image URL.");
    if (input.track === "software" && !isHttpUrl(input.demoUrl)) {
      errors.push("Software ships need a live demo or video URL.");
    }
    if (input.demoUrl && !isHttpUrl(input.demoUrl)) errors.push("The demo link must be an HTTP or HTTPS URL.");
    if (input.hackatimeProjects.length === 0 && journalMinutes <= 0) {
      errors.push("Link a Hackatime project or add at least one timed work log.");
    }
  } else {
    if (input.thumbnailUrl && !isHttpUrl(input.thumbnailUrl)) errors.push("The thumbnail must be an HTTP or HTTPS URL.");
    if (input.demoUrl && !isHttpUrl(input.demoUrl)) errors.push("The demo link must be an HTTP or HTTPS URL.");
  }
  return errors;
}

export function checkoutInput(body = {}) {
  return {
    shippingName: text(body.shipping_name, 120),
    addressLine1: text(body.address_line_1, 200),
    addressLine2: text(body.address_line_2, 200),
    city: text(body.city, 100),
    region: text(body.region, 100),
    postalCode: text(body.postal_code, 30),
    countryCode: text(body.country_code, 10).toUpperCase(),
    notes: text(body.notes, 500),
  };
}

export function validateCheckout(input) {
  const required = [
    ["shippingName", "shipping name"],
    ["addressLine1", "street address"],
    ["city", "city"],
    ["region", "state, province, or region"],
    ["postalCode", "postal code"],
    ["countryCode", "country or territory"],
  ];
  return required.filter(([key]) => !input[key]).map(([, label]) => `Add your ${label}.`);
}
