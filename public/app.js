const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector(".site-nav");

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
      urlInput.value = [...existing, ...result.images.map((image) => image.url)].slice(0, 8).join("\n");
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