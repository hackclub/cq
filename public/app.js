const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector(".site-nav");

window.addEventListener("beforeunload", () => document.body.classList.add("is-loading"));
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (new URL(link.href, location.href).origin === location.origin && !link.target && !link.hasAttribute("download")) document.body.classList.add("is-loading");
});

const utcClock = document.querySelector("[data-utc-clock]");
if (utcClock) {
  const updateClock = () => {
    const now = new Date();
    utcClock.textContent = `${now.toISOString().slice(11, 19)} UTC`;
  };
  updateClock();
  window.setInterval(updateClock, 1000);
}

menuButton?.addEventListener("click", () => {
  const expanded = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!expanded));
  navigation?.classList.toggle("open", !expanded);
});

for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}

const toast = document.querySelector(".toast");
if (toast) {
  window.setTimeout(() => {
    toast.classList.add("toast-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, toast.classList.contains("flash-error") ? 8500 : 4500);
}

for (const form of document.querySelectorAll("form[data-review-form]")) {
  const key = `cq-review-draft:${form.dataset.reviewId}:${form.dataset.reviewStage}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved && typeof saved === "object") {
      for (const [name, value] of Object.entries(saved)) {
        for (const field of form.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
          if (field.type === "checkbox") field.checked = Boolean(value);
          else if (field.type !== "hidden") field.value = String(value);
        }
      }
    }
  } catch { }
  const saveDraft = () => {
    const draft = {};
    for (const field of form.querySelectorAll("input, textarea, select")) {
      if (!field.name || field.type === "hidden" || field.type === "submit") continue;
      draft[field.name] = field.type === "checkbox" ? field.checked : field.value;
    }
    try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { }
  };
  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  form.addEventListener("submit", saveDraft);
}

const userSearch = document.querySelector("[data-user-search]");
if (userSearch) {
  const rows = [...document.querySelectorAll("[data-user-row]")];
  const count = document.querySelector("[data-user-search-count]");
  const empty = document.querySelector("[data-user-search-empty]");
  const filterUsers = () => {
    const query = userSearch.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach((row) => {
      const matches = !query || row.dataset.searchText.includes(query);
      row.hidden = !matches;
      if (matches) shown += 1;
    });
    if (count) count.textContent = `${shown} ${shown === 1 ? "person" : "people"}`;
    if (empty) empty.hidden = shown !== 0;
  };
  userSearch.addEventListener("input", filterUsers);
}

const projectTrack = document.querySelector("[data-project-track]");
const hardwareFields = document.querySelector("[data-hardware-fields]");
if (projectTrack && hardwareFields) {
  const syncTrack = () => {
    const hardware = projectTrack.value === "hardware";
    hardwareFields.hidden = !hardware;
    hardwareFields.querySelectorAll("input, textarea, select, button").forEach((field) => {
      field.disabled = !hardware;
    });
  };
  projectTrack.addEventListener("change", syncTrack);
  syncTrack();
}

const bomInput = document.querySelector("[data-bom-input]");
const bomRows = document.querySelector("[data-bom-rows]");
const bomAdd = document.querySelector("[data-bom-add]");
if (bomInput && bomRows && bomAdd) {
  let items = [];
  try {
    const parsed = JSON.parse(bomInput.value || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch { items = []; }
  const fields = ["name", "purpose", "quantity", "unitCost", "link", "distributor"];
  const labels = ["Part name", "Why it is needed", "0", "0.00", "https://…", "Supplier"];
  const renderBom = () => {
    bomRows.replaceChildren();
    items.forEach((item, index) => {
      const row = document.createElement("tr");
      fields.forEach((field, fieldIndex) => {
        const cell = document.createElement("td");
        const input = document.createElement("input");
        input.type = ["quantity", "unitCost"].includes(field) ? "number" : field === "link" ? "url" : "text";
        if (input.type === "number") { input.min = "0"; input.step = field === "quantity" ? "1" : "0.01"; }
        input.placeholder = labels[fieldIndex];
        input.value = item[field] ?? "";
        input.addEventListener("input", () => { items[index][field] = input.value; syncBom(); });
        cell.append(input); row.append(cell);
      });
      const removeCell = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "text-button danger-text"; remove.textContent = "Remove";
      remove.addEventListener("click", () => { items.splice(index, 1); renderBom(); syncBom(); });
      removeCell.append(remove); row.append(removeCell); bomRows.append(row);
    });
  };
  const syncBom = () => { bomInput.value = JSON.stringify(items); };
  bomAdd.addEventListener("click", () => { items.push({ name: "", purpose: "", quantity: "", unitCost: "", link: "", distributor: "" }); renderBom(); syncBom(); });
  if (!items.length) items.push({ name: "", purpose: "", quantity: "", unitCost: "", link: "", distributor: "" });
  renderBom(); syncBom();
}

const thumbnailUpload = document.querySelector("[data-thumbnail-upload]");
const safeImageUrl = (value) => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
if (thumbnailUpload) {
  const input = thumbnailUpload.querySelector("[data-thumbnail-file]");
  const choose = thumbnailUpload.querySelector("[data-thumbnail-choose]");
  const url = thumbnailUpload.querySelector("[data-thumbnail-url]");
  const status = thumbnailUpload.querySelector("[data-thumbnail-status]");
  const preview = thumbnailUpload.querySelector("[data-thumbnail-preview]");
  const csrf = thumbnailUpload.closest("form")?.querySelector('input[name="_csrf"]')?.value || "";
  const render = () => {
    if (!preview || !url) return;
    preview.replaceChildren();
    if (!url.value) return;
    const item = document.createElement("div"); item.className = "upload-preview-item";
    const image = document.createElement("img"); image.src = safeImageUrl(url.value); image.alt = "Project thumbnail";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove";
    remove.addEventListener("click", () => { url.value = ""; render(); });
    item.append(image, remove); preview.append(item);
  };
  choose?.addEventListener("click", (event) => {
    event.preventDefault();
    input?.click();
  });
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || !status || !url) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) { status.textContent = "Choose an image under 8 MB."; return; }
    status.textContent = "Uploading thumbnail…";
    const body = new FormData(); body.append("images", file);
    try {
      const response = await fetch("/app/projects/uploads/images", { method: "POST", headers: { "x-csrf-token": csrf, Accept: "application/json" }, body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      const uploadedUrl = result.images?.[0]?.url || result.images?.[0];
      if (!safeImageUrl(uploadedUrl)) throw new Error("Upload returned no usable image URL.");
      url.value = uploadedUrl; status.textContent = "Thumbnail uploaded."; render();
    } catch (error) { status.textContent = error.message || "Thumbnail upload failed."; }
    finally { input.value = ""; }
  });
  render();
}

for (const uploader of document.querySelectorAll("[data-shop-image-upload]")) {
  const input = uploader.querySelector("[data-shop-image-file]");
  const url = uploader.querySelector("[data-shop-image-url]");
  const status = uploader.querySelector("[data-shop-image-status]");
  const preview = uploader.querySelector("[data-shop-image-preview]");
  const csrf = uploader.closest("form")?.querySelector('input[name="_csrf"]')?.value || "";
  const render = () => {
    if (!preview || !url) return;
    preview.replaceChildren();
    if (!url.value) return;
    const image = document.createElement("img"); image.src = safeImageUrl(url.value); image.alt = "Product image preview"; preview.append(image);
  };
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || !status || !url) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) { status.textContent = "Choose an image under 8 MB."; return; }
    status.textContent = "Uploading image…";
    const body = new FormData(); body.append("image", file);
    try {
      const response = await fetch("/admin/uploads/images", { method: "POST", headers: { "x-csrf-token": csrf, Accept: "application/json" }, body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      const uploadedUrl = result.image?.url || result.image;
      if (!safeImageUrl(uploadedUrl)) throw new Error("Upload returned no usable image URL.");
      url.value = uploadedUrl; status.textContent = "Image uploaded. Save the product to apply it."; render();
    } catch (error) { status.textContent = error.message || "Image upload failed."; }
    finally { input.value = ""; }
  });
  render();
}

for (const form of document.querySelectorAll("form[data-devlog-form]")) {
  const fileInput = form.querySelector('input[type="file"][name="image_files"]');
  const urlInput = form.querySelector('input[type="hidden"][name="image_urls"]');
  const dropzone = form.querySelector(".image-dropzone");
  const status = form.querySelector(".upload-status");
  const preview = form.querySelector(".upload-preview");
  const submit = form.querySelector('button[type="submit"]');
  const csrf = form.querySelector('input[name="_csrf"]')?.value || "";
  let uploading = false;

  const urls = () => [...new Set((urlInput?.value || "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean))].slice(0, 8);

  function updateSubmit() {
    if (submit) submit.disabled = uploading || urls().length === 0;
  }

  function renderPreview() {
    if (!preview || !urlInput) return;
    preview.replaceChildren();
    urls().forEach((url, index) => {
      const item = document.createElement("div");
      item.className = "upload-preview-item";
      const image = document.createElement("img");
      image.src = url;
      image.alt = `Uploaded progress image ${index + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        urlInput.value = urls().filter((candidate) => candidate !== url).join("\n");
        renderPreview();
      });
      item.append(image, remove);
      preview.append(item);
    });
    updateSubmit();
  }

  async function upload(files) {
    const existing = urls();
    const chosen = [...files].filter((file) => file.type.startsWith("image/") && file.size <= 8 * 1024 * 1024).slice(0, 8 - existing.length);
    if (!chosen.length || !urlInput || !status) {
      if (status) status.textContent = existing.length >= 8 ? "Eight images is the maximum." : "Choose JPG, PNG, WebP, or GIF images under 8 MB.";
      return;
    }
    uploading = true;
    status.textContent = `Uploading ${chosen.length} image${chosen.length === 1 ? "" : "s"}…`;
    dropzone?.classList.add("uploading");
    updateSubmit();
    const body = new FormData();
    chosen.forEach((file) => body.append("images", file));
    try {
      const response = await fetch("/app/projects/uploads/images", {
        method: "POST",
        headers: { "x-csrf-token": csrf, Accept: "application/json" },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      const uploadedUrls = (result.images || []).map((image) => image?.url || image).filter(safeImageUrl);
      if (!uploadedUrls.length) throw new Error("Upload returned no usable image URL.");
      urlInput.value = [...existing, ...uploadedUrls].slice(0, 8).join("\n");
      status.textContent = `${result.images.length} image${result.images.length === 1 ? "" : "s"} uploaded.`;
      renderPreview();
    } catch (error) {
      status.textContent = error.message || "Image upload failed. Please try again.";
    } finally {
      uploading = false;
      dropzone?.classList.remove("uploading");
      if (fileInput) fileInput.value = "";
      updateSubmit();
    }
  }

  fileInput?.addEventListener("change", () => upload(fileInput.files || []));
  for (const eventName of ["dragenter", "dragover"]) {
    dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
    });
  }
  dropzone?.addEventListener("drop", (event) => upload(event.dataTransfer?.files || []));
  form.addEventListener("submit", (event) => {
    if (uploading || urls().length === 0) {
      event.preventDefault();
      if (status) status.textContent = uploading ? "Wait for the images to finish uploading." : "Add at least one progress image.";
    }
  });
  renderPreview();
}

const canvas = document.querySelector('.scope canvas');
if (canvas) {
  const ctx = canvas.getContext('2d');
  const palette = ['#c7a5a2', '#c1aa96', '#c3ba92', '#aebc9b', '#9db8ad', '#9eacb8', '#aaa4b9', '#b9a2af'];
  let tick = 0;

  function resize() {
    canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
  }

  window.addEventListener('resize', resize);
  resize();

  function paint() {
    tick += 0.018;
    const w = canvas.width;
    const h = canvas.height;
    const d = window.devicePixelRatio || 1;
    const bw = 7 * d;
    const g = 3 * d;
    const n = Math.ceil(w / (bw + g));

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < n; i++) {
      const q = i / (n - 1);
      const floor = 0.07 + (Math.sin(i * 0.73 + tick * 3) + Math.sin(i * 0.22 - tick)) * 0.01;
      const signal = Math.exp(-Math.pow((q - 0.5) * 24, 2)) * 0.64 +
                     Math.exp(-Math.pow((q - 0.28) * 43, 2)) * 0.22 +
                     Math.exp(-Math.pow((q - 0.74) * 55, 2)) * 0.16;
      const bh = Math.min(0.78, floor + signal) * h * 0.8;

      ctx.fillStyle = palette[Math.min(7, Math.floor(q * 8))];
      ctx.globalAlpha = 0.82;
      ctx.fillRect(i * (bw + g), h - bh - 15 * d, bw, bh);
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(paint);
  }

  paint();
}
