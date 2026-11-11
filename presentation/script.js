/* ============================================================
   Durable Workflow Engine — deck controller
   No dependencies. Works from file:// or a static server.
   ============================================================ */

(() => {
  "use strict";

  const slides = Array.from(document.querySelectorAll(".slide"));
  if (slides.length === 0) return;

  const total = slides.length;
  const body = document.body;

  const progressBar = document.getElementById("progress-bar");
  const counter = document.getElementById("slide-counter");
  const prevBtn = document.getElementById("btn-prev");
  const nextBtn = document.getElementById("btn-next");
  const notesBtn = document.getElementById("btn-notes");
  const docBtn = document.getElementById("btn-doc");
  const fullBtn = document.getElementById("btn-full");
  const hint = document.getElementById("hint");

  let index = 0;
  let documentMode = false;
  let programmaticScroll = false;
  let scrollTimer = 0;

  const clamp = (n) => Math.min(total - 1, Math.max(0, n));

  /* ---------- chrome ---------- */

  function updateChrome() {
    if (progressBar) {
      progressBar.style.width = `${((index + 1) / total) * 100}%`;
    }
    if (counter) {
      counter.textContent = `${index + 1} / ${total}`;
    }
    if (prevBtn) prevBtn.disabled = index === 0;
    if (nextBtn) nextBtn.disabled = index === total - 1;

    const title = slides[index]?.dataset.title;
    if (title) {
      document.title = `${title} — Durable Workflow Engine`;
    }
  }

  function setHash() {
    try {
      history.replaceState(null, "", `#slide-${index + 1}`);
    } catch {
      /* file:// in some browsers disallows history mutation */
    }
  }

  function applyActiveSlide() {
    slides.forEach((slide, i) => {
      const active = i === index;
      slide.classList.toggle("active", active);
      if (!documentMode) {
        slide.setAttribute("aria-hidden", active ? "false" : "true");
      }
    });
  }

  /* ---------- navigation ---------- */

  function go(next, { hash = true, smooth = true } = {}) {
    index = clamp(next);

    if (documentMode) {
      slides[index].scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "start",
      });
      programmaticScroll = true;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        programmaticScroll = false;
      }, 700);
    } else {
      applyActiveSlide();
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    if (hash) setHash();
    updateChrome();
  }

  const next = () => {
    if (index < total - 1) go(index + 1);
  };
  const prev = () => {
    if (index > 0) go(index - 1);
  };

  /* ---------- document mode ---------- */

  function updateFromScroll() {
    if (!documentMode || programmaticScroll) return;
    const probe = window.scrollY + window.innerHeight * 0.35;
    let best = 0;
    for (let i = 0; i < total; i += 1) {
      if (slides[i].offsetTop <= probe) best = i;
    }
    if (best !== index) {
      index = best;
      updateChrome();
      setHash();
    }
  }

  function setDocumentMode(on, { scroll = true } = {}) {
    documentMode = on;
    body.classList.toggle("document", on);
    body.classList.toggle("presenting", !on);

    if (docBtn) {
      docBtn.classList.toggle("active", on);
      docBtn.setAttribute("aria-pressed", String(on));
    }

    if (on) {
      slides.forEach((slide) => slide.setAttribute("aria-hidden", "false"));
      window.addEventListener("scroll", updateFromScroll, { passive: true });
      if (scroll) {
        programmaticScroll = true;
        slides[index].scrollIntoView({ behavior: "auto", block: "start" });
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
          programmaticScroll = false;
        }, 200);
      }
    } else {
      window.removeEventListener("scroll", updateFromScroll);
      applyActiveSlide();
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    updateChrome();
    setHash();
  }

  /* ---------- notes ---------- */

  function toggleNotes(force) {
    const on =
      typeof force === "boolean" ? force : !body.classList.contains("show-notes");
    body.classList.toggle("show-notes", on);
    if (notesBtn) {
      notesBtn.classList.toggle("active", on);
      notesBtn.setAttribute("aria-pressed", String(on));
    }
  }

  /* ---------- fullscreen ---------- */

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement || document.webkitFullscreenElement
    );
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } else {
      const el = document.documentElement;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (request) {
        Promise.resolve(request.call(el)).catch(() => {});
      }
    }
  }

  function syncFullscreenButton() {
    if (!fullBtn) return;
    const on = isFullscreen();
    fullBtn.classList.toggle("active", on);
    fullBtn.setAttribute("aria-pressed", String(on));
  }

  /* ---------- hash routing ---------- */

  function indexFromHash() {
    const match = /^#slide-(\d+)$/.exec(window.location.hash);
    if (!match) return null;
    const n = Number.parseInt(match[1], 10);
    if (!Number.isFinite(n)) return null;
    return clamp(n - 1);
  }

  /* ---------- events ---------- */

  if (prevBtn) {
    prevBtn.addEventListener("click", (event) => {
      prev();
      event.currentTarget.blur();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", (event) => {
      next();
      event.currentTarget.blur();
    });
  }

  if (notesBtn) {
    notesBtn.addEventListener("click", (event) => {
      toggleNotes();
      event.currentTarget.blur();
    });
  }

  if (docBtn) {
    docBtn.addEventListener("click", (event) => {
      setDocumentMode(!documentMode);
      event.currentTarget.blur();
    });
  }

  if (fullBtn) {
    fullBtn.addEventListener("click", (event) => {
      toggleFullscreen();
      event.currentTarget.blur();
    });
  }

  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);

  window.addEventListener("hashchange", () => {
    const target = indexFromHash();
    if (target !== null && target !== index) {
      go(target, { hash: false });
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const key = event.key;

    switch (key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
      case "Spacebar":
        event.preventDefault();
        next();
        return;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        prev();
        return;
      case "Home":
        event.preventDefault();
        go(0);
        return;
      case "End":
        event.preventDefault();
        go(total - 1);
        return;
      default:
        break;
    }

    switch (key.toLowerCase()) {
      case "n":
        event.preventDefault();
        toggleNotes();
        break;
      case "d":
        event.preventDefault();
        setDocumentMode(!documentMode);
        break;
      case "f":
        event.preventDefault();
        toggleFullscreen();
        break;
      default:
        break;
    }
  });

  /* ---------- touch swipe ---------- */

  let touchStartX = 0;
  let touchStartY = 0;

  window.addEventListener(
    "touchstart",
    (event) => {
      if (documentMode || event.touches.length !== 1) return;
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
    },
    { passive: true }
  );

  window.addEventListener(
    "touchend",
    (event) => {
      if (documentMode || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - touchStartX;
      const dy = event.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (dx < 0) next();
      else prev();
    },
    { passive: true }
  );

  /* ---------- init ---------- */

  const initial = indexFromHash();
  index = initial === null ? 0 : initial;

  if (body.classList.contains("document")) {
    documentMode = true;
    if (docBtn) docBtn.classList.add("active");
    slides.forEach((slide) => slide.setAttribute("aria-hidden", "false"));
    window.addEventListener("scroll", updateFromScroll, { passive: true });
    programmaticScroll = true;
    slides[index].scrollIntoView({ behavior: "auto", block: "start" });
    window.setTimeout(() => {
      programmaticScroll = false;
    }, 200);
  } else {
    applyActiveSlide();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  syncFullscreenButton();
  updateChrome();
  setHash();

  if (hint) {
    window.setTimeout(() => {
      hint.style.transition = "opacity 600ms ease";
      hint.style.opacity = "0";
    }, 6000);
  }
})();
