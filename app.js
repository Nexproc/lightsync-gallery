/**
 * Lightsync Gallery — Single-Page Photograph Viewer
 * - Aspect-preserving editorial spreads & fluid justified row solver
 * - Cursor-proximity 2x magnification on hero carousel selectors
 * - Viewport-priority progressive blur-up hydration & DOM-preserving pagination
 * - Smooth chapter jumping & responsive sticky date navigation
 */

(() => {
  "use strict";

  const STORAGE_KEYS = {
    theme: "lightsync_gallery_theme",
    favorites: "lightsync_gallery_favorites",
  };

  const PAGE_BATCH_SIZE = 30;
  const MAX_CAROUSEL_SLIDES = 7;
  const HERO_PROXIMITY_RADIUS_PX = 165;
  const MAX_CONCURRENT_HYDRATIONS = 6;

  const state = {
    manifest: null,
    photos: [],
    chapters: [],
    heroPhotos: [],
    assetBaseUrl: "./3k_exports",

    filter: "all", // 'all' | 'highlights' | 'favorites'
    visibleCount: PAGE_BATCH_SIZE,

    favorites: new Set(),
    hydratedIds: new Set(),
    activeDate: null,

    heroSlideIdx: 0,
    heroTimer: null,

    lightboxOpen: false,
    lightboxList: [],
    lightboxIdx: 0,
    lightboxZoomed: false,
  };

  const dom = {
    html: document.documentElement,
    heroStage: document.getElementById("hero-stage"),
    heroCopy: document.getElementById("hero-copy"),
    collectionEyebrow: document.getElementById("collection-eyebrow"),
    collectionTitle: document.getElementById("collection-title"),
    collectionSubtitle: document.getElementById("collection-subtitle"),
    heroShowcase: document.getElementById("hero-showcase"),
    heroSlidesLayer: document.getElementById("hero-slides-layer"),
    heroDots: document.getElementById("hero-dots"),
    btnExplore: document.getElementById("btn-explore-collection"),

    galleryNav: document.getElementById("gallery-nav"),
    dateChaptersNav: document.getElementById("date-chapters-nav"),
    filterAll: document.getElementById("filter-all"),
    filterHighlights: document.getElementById("filter-highlights"),
    filterFavorites: document.getElementById("filter-favorites"),
    btnThemeToggle: document.getElementById("btn-theme-toggle"),

    timelineScrubber: document.getElementById("timeline-scrubber"),
    galleryMain: document.getElementById("gallery-main"),
    chaptersContainer: document.getElementById("chapters-container"),
    paginationSentinel: document.getElementById("pagination-sentinel"),
    btnLoadMore: document.getElementById("btn-load-more"),

    footer: document.querySelector(".gallery-footer"),
    footerCopyright: document.getElementById("footer-copyright"),
    btnBackTop: document.getElementById("btn-back-top"),

    lightbox: document.getElementById("lightbox-modal"),
    lbCounter: document.getElementById("lb-counter"),
    lbTitle: document.getElementById("lb-title"),
    lbBtnZoom: document.getElementById("lb-btn-zoom"),
    lbBtnFav: document.getElementById("lb-btn-fav"),
    lbBtnDownload: document.getElementById("lb-btn-download"),
    lbBtnClose: document.getElementById("lb-btn-close"),
    lbStage: document.getElementById("lightbox-stage"),
    lbImgWrap: document.getElementById("lb-img-wrap"),
    lbImg: document.getElementById("lb-img"),
    lbPrev: document.getElementById("lb-prev"),
    lbNext: document.getElementById("lb-next"),
    lbFilmstrip: document.getElementById("lightbox-filmstrip"),
  };

  const cardCache = new Map(); // photoId -> { figure, hiImg, btnFav }
  const pendingHydrationSet = new Set();

  let imgObserver = null;
  let sentinelObserver = null;
  let proximityRaf = 0;
  let scrollRaf = 0;
  let pumpRaf = 0;
  let postJumpTimer = null;
  let activeHydrations = 0;
  let lastContainerWidth = 0;
  let lastDateNavKey = "";
  let suppressScrollObserversUntil = 0;
  let lastHeroDotsTouchTime = 0;
  let lastHeroSwipeTime = 0;
  let lastHeroOrientation = "";

  // =========================================================================
  // Preferences & URL State
  // =========================================================================

  function loadPersistedState() {
    try {
      const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
      if (savedTheme === "dark" || savedTheme === "light") {
        dom.html.setAttribute("data-theme", savedTheme);
      }
      const savedFavs = JSON.parse(localStorage.getItem(STORAGE_KEYS.favorites) || "[]");
      if (Array.isArray(savedFavs)) {
        state.favorites = new Set(savedFavs);
      }
    } catch (_) {}

    try {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      if (["all", "highlights", "favorites"].includes(view)) {
        state.filter = view;
      }
    } catch (_) {}
  }

  function saveFavorites() {
    try {
      localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify([...state.favorites]));
    } catch (_) {}
  }

  function syncUrlParams() {
    try {
      const url = new URL(window.location.href);
      if (state.filter === "all") url.searchParams.delete("view");
      else url.searchParams.set("view", state.filter);
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}
  }

  function resolvePhotoUrl(photo) {
    if (photo.embeddedSrc) return photo.embeddedSrc;
    if (photo.url && /^https?:\/\//i.test(photo.url)) return photo.url;
    const base = (state.assetBaseUrl || "./3k_exports").replace(/\/+$/, "");
    return `${base}/${photo.filename}`;
  }

  function getFilteredPhotos() {
    if (state.filter === "highlights") {
      return state.photos.filter((p) => p.hero);
    }
    if (state.filter === "favorites") {
      return state.photos.filter((p) => state.favorites.has(p.id));
    }
    return state.photos;
  }

  function syncNavHeight() {
    if (!dom.galleryNav) return 58;
    const h = Math.ceil(dom.galleryNav.getBoundingClientRect().height);
    if (h >= 40) {
      dom.html.style.setProperty("--nav-height", `${h}px`);
      return h;
    }
    return 58;
  }

  function updateToolbarCounts() {
    const favCount = state.favorites.size;

    dom.filterAll.textContent = state.photos.length > 0 ? `All (${state.photos.length})` : "All";
    dom.filterHighlights.textContent = "Highlights";
    dom.filterFavorites.textContent = favCount > 0 ? `Favorites (${favCount})` : "Favorites";

    dom.filterAll.classList.toggle("is-active", state.filter === "all");
    dom.filterHighlights.classList.toggle("is-active", state.filter === "highlights");
    dom.filterFavorites.classList.toggle("is-active", state.filter === "favorites");
  }

  // =========================================================================
  // 1. Hero Carousel & 2x Cursor-Proximity Selector Magnification
  // =========================================================================

  function estimateHexLuminance(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return 64;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function isWellExposedForHero(photo) {
    const lum = estimateHexLuminance(photo.dominantColor);
    const lqipLen = (photo.lqip || "").length;
    return lum >= 28 && lqipLen >= 300;
  }

  function getDesiredHeroOrientation() {
    const w = window.innerWidth || 1024;
    const h = window.innerHeight || 768;
    return h > w * 1.05 ? "portrait" : "landscape";
  }

  function getPhotoFocalPosition(photo) {
    if (Array.isArray(photo.focalPoint) && photo.focalPoint.length >= 2) {
      const fx = Number(photo.focalPoint[0]);
      const fy = Number(photo.focalPoint[1]);
      if (Number.isFinite(fx) && Number.isFinite(fy)) {
        const cx = Math.max(0, Math.min(100, fx)).toFixed(1);
        const cy = Math.max(0, Math.min(100, fy)).toFixed(1);
        return `${cx}% ${cy}%`;
      }
    }
    return "50% 44%";
  }

  function pickCarouselSlides(targetOrientation) {
    const wantOrientation = targetOrientation || getDesiredHeroOrientation();
    const rated = state.photos.filter(
      (p) => typeof p.rating === "number" && p.rating > 0
    );

    let tierCandidates = [];
    if (rated.length > 0) {
      const maxRating = rated.reduce((acc, p) => Math.max(acc, p.rating), 0);
      const topRated = state.photos.filter((p) => p.rating === maxRating);
      const topOriented = topRated.filter((p) => p.orientation === wantOrientation);

      if (topOriented.length > 0) {
        tierCandidates = topOriented;
      } else if (maxRating > 1) {
        const nextOriented = state.photos.filter(
          (p) => (p.rating || 0) >= maxRating - 1 && p.orientation === wantOrientation
        );
        tierCandidates = nextOriented.length > 0 ? nextOriented : topRated;
      } else {
        tierCandidates = topRated;
      }
    } else {
      const heroOriented = state.photos.filter(
        (p) => p.hero && p.orientation === wantOrientation
      );
      tierCandidates =
        heroOriented.length > 0
          ? heroOriented
          : state.photos.filter((p) => p.orientation === wantOrientation);
    }

    const brightPool = tierCandidates.filter(isWellExposedForHero);
    let source =
      brightPool.length >= Math.min(3, tierCandidates.length)
        ? brightPool
        : tierCandidates;

    if (source.length === 0) {
      source = state.photos;
    }

    if (source.length <= MAX_CAROUSEL_SLIDES) {
      return source;
    }

    const sampled = [];
    for (let i = 0; i < MAX_CAROUSEL_SLIDES; i++) {
      const idx = Math.floor((i * (source.length - 1)) / (MAX_CAROUSEL_SLIDES - 1));
      sampled.push(source[idx]);
    }
    return sampled;
  }

  function ensureHeroSlideLoaded(slideIdx, isPriority = false) {
    const slides = dom.heroSlidesLayer.querySelectorAll(".hero-slide");
    const count = slides.length;
    if (!count) return;
    const normIdx = ((slideIdx % count) + count) % count;
    const slide = slides[normIdx];
    const photo = state.heroPhotos[normIdx];
    if (!slide || !photo) return;

    const hiImg = slide.querySelector(".hero-hi");
    if (!hiImg || hiImg.dataset.started === "1") return;

    hiImg.dataset.started = "1";
    if (isPriority && "fetchPriority" in hiImg) {
      hiImg.fetchPriority = "high";
    }

    const reveal = () => {
      slide.classList.add("is-loaded");
      state.hydratedIds.add(photo.id);
      if (isPriority && count > 1) {
        ensureHeroSlideLoaded(normIdx + 1, false);
      }
    };

    hiImg.addEventListener(
      "load",
      () => {
        if (typeof hiImg.decode === "function") {
          hiImg.decode().then(reveal).catch(reveal);
        } else {
          reveal();
        }
      },
      { once: true }
    );
    hiImg.addEventListener("error", reveal, { once: true });
    hiImg.src = resolvePhotoUrl(photo);
  }

  function renderHeroCover() {
    const wantOrientation = getDesiredHeroOrientation();
    lastHeroOrientation = wantOrientation;
    state.heroPhotos = pickCarouselSlides(wantOrientation);

    if (state.heroSlideIdx >= state.heroPhotos.length) {
      state.heroSlideIdx = 0;
    }

    dom.heroSlidesLayer.replaceChildren();
    dom.heroDots.replaceChildren();
    dom.heroDots.hidden = state.heroPhotos.length <= 1;

    state.heroPhotos.forEach((photo, idx) => {
      const slide = document.createElement("div");
      const mismatchClass =
        photo.orientation && photo.orientation !== wantOrientation
          ? " is-contain-fallback"
          : "";
      slide.className = `hero-slide${idx === state.heroSlideIdx ? " is-active" : ""}${mismatchClass}`;
      slide.style.backgroundColor = photo.dominantColor || "#141210";
      slide.style.setProperty("--focal-pos", getPhotoFocalPosition(photo));

      if (photo.lqip) {
        const lqipImg = document.createElement("img");
        lqipImg.className = "hero-lqip";
        lqipImg.src = photo.lqip;
        lqipImg.alt = "";
        lqipImg.draggable = false;
        lqipImg.setAttribute("aria-hidden", "true");
        slide.appendChild(lqipImg);
      }

      const img = document.createElement("img");
      img.className = "hero-hi";
      img.alt = photo.filename;
      img.decoding = "async";
      img.draggable = false;
      slide.appendChild(img);

      slide.addEventListener("click", () => {
        if (performance.now() - lastHeroSwipeTime < 450) return;
        openLightboxByPhotoId(photo.id);
      });
      dom.heroSlidesLayer.appendChild(slide);

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `hero-dot${idx === state.heroSlideIdx ? " is-active" : ""}`;
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-selected", idx === state.heroSlideIdx ? "true" : "false");
      dot.setAttribute("aria-label", `Slide ${idx + 1}`);

      const bar = document.createElement("span");
      bar.className = "hero-dot-bar";
      dot.appendChild(bar);

      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (performance.now() - lastHeroDotsTouchTime < 600) return;
        setActiveHeroSlide(idx);
        restartHeroSlideshow();
      });

      dom.heroDots.appendChild(dot);
    });

    ensureHeroSlideLoaded(state.heroSlideIdx, true);
    restartHeroSlideshow();
  }

  function setActiveHeroSlide(nextIdx) {
    const count = state.heroPhotos.length;
    if (!count) return;
    state.heroSlideIdx = ((nextIdx % count) + count) % count;

    const slides = dom.heroSlidesLayer.querySelectorAll(".hero-slide");
    slides.forEach((el, idx) => el.classList.toggle("is-active", idx === state.heroSlideIdx));

    const dots = dom.heroDots.querySelectorAll(".hero-dot");
    dots.forEach((dot, idx) => {
      const active = idx === state.heroSlideIdx;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-selected", active ? "true" : "false");
    });

    ensureHeroSlideLoaded(state.heroSlideIdx, true);
  }

  function restartHeroSlideshow() {
    clearInterval(state.heroTimer);
    if (state.heroPhotos.length <= 1) return;
    state.heroTimer = setInterval(() => {
      if (state.lightboxOpen) return;
      const rect = dom.heroStage.getBoundingClientRect();
      if (rect.bottom < 0) return;
      setActiveHeroSlide(state.heroSlideIdx + 1);
    }, 5500);
  }

  function updateHeroDotsProximity(clientX, clientY) {
    const dots = dom.heroDots.querySelectorAll(".hero-dot");
    if (!dots.length) return;

    const groupRect = dom.heroDots.getBoundingClientRect();
    if (
      clientX < groupRect.left - HERO_PROXIMITY_RADIUS_PX ||
      clientX > groupRect.right + HERO_PROXIMITY_RADIUS_PX ||
      clientY < groupRect.top - HERO_PROXIMITY_RADIUS_PX ||
      clientY > groupRect.bottom + HERO_PROXIMITY_RADIUS_PX
    ) {
      resetHeroDotsProximity();
      return;
    }

    dots.forEach((dot) => {
      const r = dot.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      const t = Math.max(0, Math.min(1, 1 - dist / HERO_PROXIMITY_RADIUS_PX));
      const smooth = t * t * (3 - 2 * t);
      dot.style.setProperty("--prox", smooth.toFixed(3));
    });
  }

  function selectHeroDotAtTouchX(clientX) {
    const dots = Array.from(dom.heroDots.querySelectorAll(".hero-dot"));
    if (!dots.length) return;

    let closestIdx = 0;
    let minDist = Infinity;
    dots.forEach((dot, idx) => {
      const r = dot.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const dist = Math.abs(clientX - cx);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = idx;
      }
      const t = Math.max(0, Math.min(1, 1 - dist / 64));
      const smooth = t * t * (3 - 2 * t);
      dot.style.setProperty("--prox", smooth.toFixed(3));
    });

    if (closestIdx !== state.heroSlideIdx) {
      setActiveHeroSlide(closestIdx);
    }
    restartHeroSlideshow();
  }

  function resetHeroDotsProximity() {
    dom.heroDots.querySelectorAll(".hero-dot").forEach((dot) => {
      dot.style.setProperty("--prox", "0");
    });
  }

  // =========================================================================
  // 2. Date Navigation & Timeline Scrubber (Shown Only When 2+ Dates Exist)
  // =========================================================================

  function syncScrubberVisibility() {
    if (!dom.timelineScrubber || dom.timelineScrubber.hidden) {
      if (dom.timelineScrubber) dom.timelineScrubber.classList.remove("is-visible");
      return;
    }
    if (!dom.heroStage) {
      dom.timelineScrubber.classList.add("is-visible");
      return;
    }
    const heroRect = dom.heroStage.getBoundingClientRect();
    dom.timelineScrubber.classList.toggle("is-visible", heroRect.bottom <= 4);
  }

  function renderDateNavigation(filteredPhotos) {
    const countsByDate = new Map();
    for (const p of filteredPhotos) {
      countsByDate.set(p.date, (countsByDate.get(p.date) || 0) + 1);
    }

    const activeChapters = state.chapters.filter((ch) => countsByDate.has(ch.date));
    if (activeChapters.length <= 1) {
      lastDateNavKey = "";
      dom.dateChaptersNav.replaceChildren();
      dom.timelineScrubber.replaceChildren();
      dom.dateChaptersNav.hidden = true;
      dom.timelineScrubber.hidden = true;
      dom.timelineScrubber.classList.remove("is-visible");
      return;
    }

    if (!state.activeDate || !countsByDate.has(state.activeDate)) {
      state.activeDate = activeChapters[0].date;
    }

    const navKey = activeChapters.map((ch) => `${ch.date}:${ch.label}`).join("|");
    dom.dateChaptersNav.hidden = false;
    dom.timelineScrubber.hidden = false;
    syncScrubberVisibility();

    if (navKey === lastDateNavKey) {
      highlightActiveDateUI(state.activeDate, false);
      return;
    }

    lastDateNavKey = navKey;
    dom.dateChaptersNav.replaceChildren();
    dom.timelineScrubber.replaceChildren();

    activeChapters.forEach((ch) => {
      const isCurrent = state.activeDate === ch.date;

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `nav-pill${isCurrent ? " is-active" : ""}`;
      pill.dataset.date = ch.date;
      pill.textContent = ch.label;
      pill.addEventListener("click", () => jumpToDateChapter(ch.date));
      dom.dateChaptersNav.appendChild(pill);

      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = `scrubber-tick${isCurrent ? " is-active" : ""}`;
      tick.dataset.date = ch.date;
      tick.innerHTML = `
        <span class="scrubber-label">${ch.label}</span>
        <span class="scrubber-line"></span>
      `;
      tick.addEventListener("click", () => jumpToDateChapter(ch.date));
      dom.timelineScrubber.appendChild(tick);
    });
  }

  function highlightActiveDateUI(dateKey, centerStrip = true) {
    let activePill = null;
    dom.dateChaptersNav.querySelectorAll(".nav-pill").forEach((btn) => {
      const match = btn.dataset.date === dateKey;
      btn.classList.toggle("is-active", match);
      if (match) activePill = btn;
    });

    dom.timelineScrubber.querySelectorAll(".scrubber-tick").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.date === dateKey);
    });

    if (centerStrip && activePill && !dom.dateChaptersNav.hidden) {
      const strip = dom.dateChaptersNav;
      if (strip.scrollWidth > strip.clientWidth + 4) {
        const targetLeft =
          activePill.offsetLeft - (strip.clientWidth - activePill.offsetWidth) * 0.5;
        strip.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
      }
    }
  }

  function scheduleHydrationAfterJump(delayMs = 380) {
    clearTimeout(postJumpTimer);
    postJumpTimer = setTimeout(() => {
      suppressScrollObserversUntil = 0;
      schedulePumpHydration();
      checkSentinelIfVisible();
    }, delayMs);
  }

  function jumpToDateChapter(dateKey) {
    const filtered = getFilteredPhotos();
    const firstIdx = filtered.findIndex((p) => p.date === dateKey);
    if (firstIdx === -1) return;

    let minNeeded = Math.min(filtered.length, firstIdx + PAGE_BATCH_SIZE);
    if (filtered.length - minNeeded <= PAGE_BATCH_SIZE) {
      minNeeded = filtered.length;
    }

    suppressScrollObserversUntil = performance.now() + 900;

    if (state.visibleCount < minNeeded) {
      state.visibleCount = minNeeded;
      renderGallery();
    }

    state.activeDate = dateKey;
    highlightActiveDateUI(dateKey, true);

    requestAnimationFrame(() => {
      const navH = syncNavHeight();
      const section = document.getElementById(`chapter-${dateKey}`);
      if (!section) return;

      const targetTop = Math.max(
        0,
        window.scrollY + section.getBoundingClientRect().top - navH - 12
      );
      const dist = Math.abs(targetTop - window.scrollY);

      if (dist > window.innerHeight * 2.5) {
        const approachOffset = Math.min(220, Math.round(window.innerHeight * 0.28));
        const approachTop =
          targetTop > window.scrollY
            ? Math.max(0, targetTop - approachOffset)
            : targetTop + approachOffset;
        window.scrollTo({ top: approachTop, behavior: "instant" });
        requestAnimationFrame(() => {
          const settledNavH = syncNavHeight();
          const finalTop = Math.max(
            0,
            window.scrollY + section.getBoundingClientRect().top - settledNavH - 12
          );
          window.scrollTo({ top: finalTop, behavior: "smooth" });
          scheduleHydrationAfterJump(420);
        });
      } else {
        window.scrollTo({ top: targetTop, behavior: "smooth" });
        scheduleHydrationAfterJump(420);
      }
    });
  }

  function updateActiveChapterFromScroll() {
    if (performance.now() < suppressScrollObserversUntil) return;
    if (dom.dateChaptersNav.hidden) return;

    const sections = dom.chaptersContainer.querySelectorAll(".date-chapter");
    if (!sections.length) return;

    const navH = dom.galleryNav ? dom.galleryNav.getBoundingClientRect().height : 58;
    const thresholdY = navH + 56;

    let candidate = sections[0].dataset.date;
    for (const sec of sections) {
      const top = sec.getBoundingClientRect().top;
      if (top <= thresholdY) {
        candidate = sec.dataset.date;
      } else {
        break;
      }
    }

    if (candidate && candidate !== state.activeDate) {
      state.activeDate = candidate;
      highlightActiveDateUI(candidate, true);
    }
  }

  // =========================================================================
  // 3. Aspect-Preserving Auto-Layout Engine (Hero Spreads + Justified Rows)
  // =========================================================================

  function getContainerInnerWidth() {
    if (dom.galleryMain) {
      const style = window.getComputedStyle(dom.galleryMain);
      const padX =
        (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const inner = dom.galleryMain.clientWidth - padX;
      if (inner > 80) return Math.floor(inner);
    }
    const fallbackViewport = document.documentElement.clientWidth || window.innerWidth;
    return Math.min(1400, Math.max(280, fallbackViewport - 32));
  }

  function getTargetRowHeight(containerWidth) {
    if (containerWidth < 560) return 230;
    if (containerWidth < 900) return 300;
    return 390;
  }

  function makeRowBlock(items, height, clamped) {
    const ids = items.map((x) => x.photo.id).join(",");
    return {
      type: "row",
      clamped: Boolean(clamped),
      key: `r:${clamped ? 1 : 0}:${Math.round(height * 10)}:${ids}`,
      items,
    };
  }

  function solveJustifiedRows(photos, containerWidth, gutter) {
    const targetH = getTargetRowHeight(containerWidth);
    const maxSingleH = Math.min(520, Math.round(window.innerHeight * 0.68));
    const blocks = [];

    let row = [];
    let aspectSum = 0;

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      row.push(p);
      aspectSum += p.aspect;

      const availW = containerWidth - gutter * (row.length - 1);
      const naturalH = availW / aspectSum;
      const isLast = i === photos.length - 1;

      if (naturalH <= targetH * 1.16 || row.length >= 4) {
        blocks.push(
          makeRowBlock(
            row.map((item) => ({
              photo: item,
              width: item.aspect * naturalH,
              height: naturalH,
            })),
            naturalH,
            false
          )
        );
        row = [];
        aspectSum = 0;
      } else if (isLast) {
        const clampedH = Math.min(naturalH, maxSingleH);
        const isClamped = clampedH < naturalH - 0.5;
        blocks.push(
          makeRowBlock(
            row.map((item) => ({
              photo: item,
              width: item.aspect * clampedH,
              height: clampedH,
            })),
            clampedH,
            isClamped
          )
        );
      }
    }

    return blocks;
  }

  function trySolveHeroSpread(slice, containerWidth, gutter, heroOnRight) {
    if (containerWidth < 680 || slice.length < 3) return null;

    const heroIdx = slice.findIndex((p) => p.hero);
    if (heroIdx === -1) return null;

    const hero = slice[heroIdx];
    const companions = slice.filter((_, idx) => idx !== heroIdx).slice(0, 2);
    if (companions.length < 2) return null;

    const aH = hero.aspect;
    const a1 = companions[0].aspect;
    const a2 = companions[1].aspect;
    const invSum = 1 / a1 + 1 / a2;

    const wStack = (containerWidth - gutter * (1 + aH)) / (1 + aH * invSum);
    if (wStack < 165) return null;

    const h1 = wStack / a1;
    const h2 = wStack / a2;
    const totalH = h1 + h2 + gutter;
    const wHero = containerWidth - gutter - wStack;

    if (totalH < 330 || totalH > 760 || wHero < 280) {
      return null;
    }

    return {
      type: "spread",
      heroOnRight,
      key: `s:${heroOnRight ? 1 : 0}:${Math.round(totalH * 10)}:${hero.id}:${companions[0].id},${companions[1].id}`,
      heroItem: { photo: hero, width: wHero, height: totalH },
      stackWidth: wStack,
      stackItems: [
        { photo: companions[0], width: wStack, height: h1 },
        { photo: companions[1], width: wStack, height: h2 },
      ],
    };
  }

  function solveAutoLayout(photos, containerWidth, gutter) {
    if (containerWidth < 680 || state.filter === "highlights") {
      return solveJustifiedRows(photos, containerWidth, gutter);
    }

    const blocks = [];
    let cursor = 0;
    let spreadParity = 0;

    while (cursor < photos.length) {
      const spread = trySolveHeroSpread(
        photos.slice(cursor, cursor + 3),
        containerWidth,
        gutter,
        spreadParity % 2 === 1
      );

      if (spread) {
        blocks.push(spread);
        spreadParity += 1;
        cursor += 3;
        continue;
      }

      const rowSlice = [];
      while (cursor < photos.length && rowSlice.length < 3) {
        if (
          rowSlice.length >= 2 &&
          trySolveHeroSpread(photos.slice(cursor, cursor + 3), containerWidth, gutter, false)
        ) {
          break;
        }
        rowSlice.push(photos[cursor]);
        cursor += 1;

        const aspectSum = rowSlice.reduce((acc, p) => acc + p.aspect, 0);
        const estH = (containerWidth - gutter * (rowSlice.length - 1)) / aspectSum;
        if (estH <= getTargetRowHeight(containerWidth) * 1.15) {
          break;
        }
      }

      blocks.push(...solveJustifiedRows(rowSlice, containerWidth, gutter));
    }

    return blocks;
  }

  // =========================================================================
  // 4. Cached Photo Cards & Viewport-Priority Hydration Queue
  // =========================================================================

  function syncCardFavoriteButton(photoId) {
    const cached = cardCache.get(photoId);
    if (!cached) return;
    const isFav = state.favorites.has(photoId);
    cached.btnFav.classList.toggle("is-fav", isFav);
    cached.btnFav.title = isFav ? "Remove from Favorites" : "Save to Favorites";
    cached.btnFav.textContent = isFav ? "♥" : "♡";
  }

  function getOrCreatePhotoCard(photo) {
    let entry = cardCache.get(photo.id);
    if (!entry) {
      const figure = document.createElement("figure");
      figure.className = "photo-card";
      figure.style.margin = "0";
      figure.style.setProperty("--tile-bg", photo.dominantColor || "#1c1917");

      const lqipImg = document.createElement("img");
      lqipImg.className = "photo-lqip";
      lqipImg.src = photo.lqip;
      lqipImg.alt = "";
      lqipImg.setAttribute("aria-hidden", "true");
      figure.appendChild(lqipImg);

      const hiImg = document.createElement("img");
      hiImg.className = "photo-hi";
      hiImg.alt = photo.filename;
      hiImg.decoding = "async";
      hiImg.dataset.photoId = photo.id;
      figure.appendChild(hiImg);

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";

      const topActions = document.createElement("div");
      topActions.className = "card-top-actions";

      const btnFav = document.createElement("button");
      btnFav.type = "button";
      btnFav.className = "card-action-btn";
      btnFav.addEventListener("click", (ev) => {
        ev.stopPropagation();
        togglePhotoFavorite(photo.id);
      });

      const btnDl = document.createElement("a");
      btnDl.className = "card-action-btn";
      btnDl.href = resolvePhotoUrl(photo);
      btnDl.download = photo.filename;
      btnDl.title = "Download photograph";
      btnDl.textContent = "↓";
      btnDl.addEventListener("click", (ev) => ev.stopPropagation());

      topActions.append(btnFav, btnDl);
      overlay.appendChild(topActions);
      figure.appendChild(overlay);

      figure.addEventListener("click", () => openLightboxByPhotoId(photo.id));

      entry = { figure, hiImg, btnFav };
      cardCache.set(photo.id, entry);
    }

    syncCardFavoriteButton(photo.id);

    if (state.hydratedIds.has(photo.id)) {
      if (!entry.hiImg.getAttribute("src")) {
        entry.hiImg.src = resolvePhotoUrl(photo);
      }
      entry.figure.classList.add("is-loaded");
    } else if (
      !entry.hiImg.getAttribute("src") &&
      !pendingHydrationSet.has(entry.hiImg) &&
      imgObserver
    ) {
      imgObserver.observe(entry.hiImg);
    }

    return entry.figure;
  }

  function startImageHydration(imgEl) {
    const photoId = imgEl.dataset.photoId;
    if (!photoId || imgEl.getAttribute("src")) return;
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return;

    activeHydrations += 1;
    let settled = false;

    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      activeHydrations = Math.max(0, activeHydrations - 1);

      if (ok) {
        const card = imgEl.closest(".photo-card");
        if (card) card.classList.add("is-loaded");
        state.hydratedIds.add(photoId);
      } else {
        imgEl.removeAttribute("src");
        if (imgEl.isConnected && imgObserver) {
          imgObserver.observe(imgEl);
        }
      }

      schedulePumpHydration();
    };

    const safetyTimer = setTimeout(() => {
      finalize(Boolean(imgEl.complete && imgEl.naturalWidth > 0));
    }, 9000);

    const onLoaded = () => {
      if (typeof imgEl.decode === "function") {
        imgEl
          .decode()
          .then(() => finalize(true))
          .catch(() => finalize(true));
      } else {
        finalize(true);
      }
    };

    imgEl.addEventListener("load", onLoaded, { once: true });
    imgEl.addEventListener("error", () => finalize(false), { once: true });
    imgEl.src = resolvePhotoUrl(photo);

    if (imgEl.complete && imgEl.naturalWidth > 0) {
      onLoaded();
    }
  }

  function schedulePumpHydration() {
    if (pumpRaf) return;
    pumpRaf = requestAnimationFrame(() => {
      pumpRaf = 0;
      pumpHydrationQueue();
    });
  }

  function pumpHydrationQueue() {
    if (!pendingHydrationSet.size) return;

    const now = performance.now();
    if (now < suppressScrollObserversUntil) {
      scheduleHydrationAfterJump(Math.ceil(suppressScrollObserversUntil - now) + 30);
      return;
    }

    if (activeHydrations >= MAX_CONCURRENT_HYDRATIONS) return;

    const vh = window.innerHeight || 800;
    const centerV = vh * 0.5;
    const candidates = [];

    for (const imgEl of pendingHydrationSet) {
      if (!imgEl.isConnected || imgEl.getAttribute("src")) {
        pendingHydrationSet.delete(imgEl);
        continue;
      }

      const rect = imgEl.getBoundingClientRect();
      if (rect.bottom < -520 || rect.top > vh + 520) {
        pendingHydrationSet.delete(imgEl);
        if (imgObserver) imgObserver.observe(imgEl);
        continue;
      }

      const inViewport = rect.bottom >= 0 && rect.top <= vh;
      const midY = (rect.top + rect.bottom) * 0.5;
      const score = (inViewport ? 0 : 10000) + Math.abs(midY - centerV);
      candidates.push({ imgEl, score });
    }

    candidates.sort((a, b) => a.score - b.score);

    for (const item of candidates) {
      if (activeHydrations >= MAX_CONCURRENT_HYDRATIONS) break;
      pendingHydrationSet.delete(item.imgEl);
      startImageHydration(item.imgEl);
    }
  }

  function checkSentinelIfVisible() {
    if (performance.now() < suppressScrollObserversUntil) return;
    if (!dom.paginationSentinel) return;
    const total = getFilteredPhotos().length;
    if (state.visibleCount >= total) return;

    const rect = dom.paginationSentinel.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (rect.top <= vh + 360) {
      state.visibleCount = Math.min(total, state.visibleCount + PAGE_BATCH_SIZE);
      renderGallery();
    }
  }

  function setupObservers() {
    if (imgObserver) imgObserver.disconnect();
    imgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            imgObserver.unobserve(entry.target);
            pendingHydrationSet.add(entry.target);
          }
        }
        schedulePumpHydration();
      },
      { rootMargin: "300px 0px" }
    );

    if (sentinelObserver) sentinelObserver.disconnect();
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (performance.now() < suppressScrollObserversUntil) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const total = getFilteredPhotos().length;
            if (state.visibleCount < total) {
              state.visibleCount = Math.min(total, state.visibleCount + PAGE_BATCH_SIZE);
              renderGallery();
            }
          }
        }
      },
      { rootMargin: "420px 0px" }
    );
    sentinelObserver.observe(dom.paginationSentinel);
  }

  // =========================================================================
  // 5. Incremental Non-Destructive Gallery Rendering
  // =========================================================================

  function buildSingleBlockDOM(block) {
    if (block.type === "spread") {
      const spreadEl = document.createElement("div");
      spreadEl.className = "editorial-spread";
      spreadEl.dataset.blockKey = block.key;

      const heroCard = getOrCreatePhotoCard(block.heroItem.photo);
      heroCard.style.flex = `${block.heroItem.width.toFixed(3)} 1 0%`;
      heroCard.style.width = "auto";
      heroCard.style.height = `${block.heroItem.height.toFixed(2)}px`;

      const stackEl = document.createElement("div");
      stackEl.className = "spread-stack";
      stackEl.style.flex = `${block.stackWidth.toFixed(3)} 1 0%`;
      stackEl.style.width = "auto";

      for (const sItem of block.stackItems) {
        const sCard = getOrCreatePhotoCard(sItem.photo);
        sCard.style.flex = `0 0 ${sItem.height.toFixed(2)}px`;
        sCard.style.width = "100%";
        sCard.style.height = `${sItem.height.toFixed(2)}px`;
        stackEl.appendChild(sCard);
      }

      if (block.heroOnRight) {
        spreadEl.append(stackEl, heroCard);
      } else {
        spreadEl.append(heroCard, stackEl);
      }
      return spreadEl;
    }

    const rowEl = document.createElement("div");
    rowEl.className = "gallery-row";
    rowEl.dataset.blockKey = block.key;

    for (const rItem of block.items) {
      const card = getOrCreatePhotoCard(rItem.photo);
      if (block.clamped) {
        card.style.flex = `0 1 ${rItem.width.toFixed(2)}px`;
        card.style.width = `${rItem.width.toFixed(2)}px`;
      } else {
        card.style.flex = `${rItem.photo.aspect} 1 0%`;
        card.style.width = "auto";
      }
      card.style.height = `${rItem.height.toFixed(2)}px`;
      rowEl.appendChild(card);
    }

    return rowEl;
  }

  function reconcileBlocksContainer(rowsWrap, blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const existing = rowsWrap.children[i];
      if (existing && existing.dataset.blockKey === block.key) {
        continue;
      }
      const nextEl = buildSingleBlockDOM(block);
      if (existing) {
        rowsWrap.replaceChild(nextEl, existing);
      } else {
        rowsWrap.appendChild(nextEl);
      }
    }

    while (rowsWrap.children.length > blocks.length) {
      rowsWrap.lastElementChild.remove();
    }
  }

  function renderGallery() {
    const filtered = getFilteredPhotos();
    updateToolbarCounts();
    renderDateNavigation(filtered);
    syncNavHeight();

    if (filtered.length === 0) {
      if (dom.chaptersContainer.dataset.mode !== "empty") {
        dom.chaptersContainer.replaceChildren();
        dom.chaptersContainer.dataset.mode = "empty";
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = `
          <h3>No saved favorites yet</h3>
          <p>Click ♡ on any photograph to add it to your favorites.</p>
        `;
        dom.chaptersContainer.appendChild(empty);
      }
      dom.btnLoadMore.hidden = true;
      return;
    }

    const containerWidth = getContainerInnerWidth();
    lastContainerWidth = containerWidth;
    const gutter = 12;

    const visibleSlice = filtered.slice(0, state.visibleCount);
    const totalDistinctDates = new Set(filtered.map((p) => p.date)).size;

    if (totalDistinctDates <= 1) {
      if (dom.chaptersContainer.dataset.mode !== "single") {
        dom.chaptersContainer.replaceChildren();
        dom.chaptersContainer.dataset.mode = "single";
        const rowsWrap = document.createElement("div");
        rowsWrap.className = "chapter-rows";
        dom.chaptersContainer.appendChild(rowsWrap);
      }
      const rowsWrap = dom.chaptersContainer.firstElementChild;
      const blocks = solveAutoLayout(visibleSlice, containerWidth, gutter);
      reconcileBlocksContainer(rowsWrap, blocks);
    } else {
      if (dom.chaptersContainer.dataset.mode !== "chapters") {
        dom.chaptersContainer.replaceChildren();
        dom.chaptersContainer.dataset.mode = "chapters";
      }

      const existingByDate = new Map();
      for (const child of Array.from(dom.chaptersContainer.children)) {
        if (child.dataset.date) {
          existingByDate.set(child.dataset.date, child);
        }
      }

      const totalByDate = new Map();
      for (const p of filtered) {
        totalByDate.set(p.date, (totalByDate.get(p.date) || 0) + 1);
      }

      const activeSections = [];
      for (const ch of state.chapters) {
        const chPhotos = visibleSlice.filter((p) => p.date === ch.date);
        if (chPhotos.length === 0) continue;

        let section = existingByDate.get(ch.date);
        let rowsWrap = null;
        let countSpan = null;

        if (!section) {
          section = document.createElement("section");
          section.className = "date-chapter";
          section.id = `chapter-${ch.date}`;
          section.dataset.date = ch.date;

          const header = document.createElement("div");
          header.className = "chapter-header";

          const dateSpan = document.createElement("span");
          dateSpan.className = "chapter-date-tag";
          dateSpan.textContent = ch.fullDate || ch.date;

          countSpan = document.createElement("span");
          countSpan.className = "chapter-count-tag";

          header.append(dateSpan, countSpan);

          rowsWrap = document.createElement("div");
          rowsWrap.className = "chapter-rows";

          section.append(header, rowsWrap);
        } else {
          existingByDate.delete(ch.date);
          countSpan = section.querySelector(".chapter-count-tag");
          rowsWrap = section.querySelector(".chapter-rows");
        }

        if (countSpan) {
          countSpan.textContent = `${totalByDate.get(ch.date) || chPhotos.length}`;
        }

        const blocks = solveAutoLayout(chPhotos, containerWidth, gutter);
        reconcileBlocksContainer(rowsWrap, blocks);
        activeSections.push(section);
      }

      for (const staleSection of existingByDate.values()) {
        staleSection.remove();
      }

      for (let i = 0; i < activeSections.length; i++) {
        const sec = activeSections[i];
        if (dom.chaptersContainer.children[i] !== sec) {
          dom.chaptersContainer.insertBefore(sec, dom.chaptersContainer.children[i] || null);
        }
      }
    }

    dom.btnLoadMore.hidden = visibleSlice.length >= filtered.length;
    schedulePumpHydration();
  }

  // =========================================================================
  // 6. Favorites & Lightbox
  // =========================================================================

  function togglePhotoFavorite(photoId) {
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return;

    if (state.favorites.has(photoId)) {
      state.favorites.delete(photoId);
    } else {
      state.favorites.add(photoId);
    }
    saveFavorites();
    syncCardFavoriteButton(photoId);

    if (state.filter === "favorites") {
      renderGallery();
    } else {
      updateToolbarCounts();
      syncNavHeight();
    }

    if (state.lightboxOpen) syncLightboxControls();
  }

  function openLightboxByPhotoId(photoId) {
    const list = getFilteredPhotos();
    const idx = list.findIndex((p) => p.id === photoId);
    if (idx === -1) return;

    state.lightboxList = list;
    state.lightboxIdx = idx;
    state.lightboxOpen = true;
    setLightboxZoom(false);

    dom.lightbox.classList.add("is-open");
    document.body.style.overflow = "hidden";

    renderLightboxFilmstrip();
    updateLightboxSlide();
  }

  function closeLightbox() {
    state.lightboxOpen = false;
    setLightboxZoom(false);
    dom.lightbox.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  function stepLightbox(delta) {
    if (!state.lightboxList.length) return;
    setLightboxZoom(false);
    state.lightboxIdx =
      (state.lightboxIdx + delta + state.lightboxList.length) % state.lightboxList.length;
    updateLightboxSlide();
  }

  function setLightboxZoom(zoomed) {
    state.lightboxZoomed = zoomed;
    dom.lbImgWrap.classList.toggle("is-zoomed", zoomed);
    dom.lbBtnZoom.classList.toggle("is-active", zoomed);
    dom.lbBtnZoom.innerHTML = zoomed
      ? '<span aria-hidden="true">⊖</span><span class="lb-btn-label">Fit</span>'
      : '<span aria-hidden="true">⊕</span><span class="lb-btn-label">Zoom</span>';
    if (!zoomed) {
      dom.lbImg.style.transformOrigin = "center center";
    }
  }

  function preloadNeighborLightboxSlides() {
    const len = state.lightboxList.length;
    if (len <= 1) return;
    for (const delta of [1, -1]) {
      const neighbor = state.lightboxList[(state.lightboxIdx + delta + len) % len];
      if (neighbor && !state.hydratedIds.has(neighbor.id)) {
        const pre = new Image();
        pre.decoding = "async";
        pre.src = resolvePhotoUrl(neighbor);
      }
    }
  }

  function updateLightboxSlide() {
    const photo = state.lightboxList[state.lightboxIdx];
    if (!photo) return;

    const url = resolvePhotoUrl(photo);
    dom.lbImg.src = url;
    dom.lbImg.alt = photo.filename;
    state.hydratedIds.add(photo.id);

    dom.lbCounter.textContent = `${state.lightboxIdx + 1} / ${state.lightboxList.length}`;
    dom.lbTitle.textContent = photo.filename;

    dom.lbBtnDownload.href = url;
    dom.lbBtnDownload.download = photo.filename;

    syncLightboxControls();
    preloadNeighborLightboxSlides();

    const activeThumb = dom.lbFilmstrip.children[state.lightboxIdx];
    dom.lbFilmstrip.querySelectorAll(".lb-thumb.is-active").forEach((el) => {
      if (el !== activeThumb) el.classList.remove("is-active");
    });
    if (activeThumb) {
      activeThumb.classList.add("is-active");
      const targetLeft =
        activeThumb.offsetLeft -
        (dom.lbFilmstrip.clientWidth - activeThumb.offsetWidth) * 0.5;
      dom.lbFilmstrip.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
    }
  }

  function syncLightboxControls() {
    const photo = state.lightboxList[state.lightboxIdx];
    if (!photo) return;
    const isFav = state.favorites.has(photo.id);
    dom.lbBtnFav.classList.toggle("is-active", isFav);
    dom.lbBtnFav.innerHTML = isFav
      ? '<span aria-hidden="true">♥</span><span class="lb-btn-label">Favorited</span>'
      : '<span aria-hidden="true">♡</span><span class="lb-btn-label">Favorite</span>';
  }

  function renderLightboxFilmstrip() {
    dom.lbFilmstrip.replaceChildren();
    state.lightboxList.forEach((photo, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lb-thumb${idx === state.lightboxIdx ? " is-active" : ""}`;
      const img = document.createElement("img");
      img.src = photo.lqip;
      img.alt = photo.filename;
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        setLightboxZoom(false);
        state.lightboxIdx = idx;
        updateLightboxSlide();
      });
      dom.lbFilmstrip.appendChild(btn);
    });
  }

  // =========================================================================
  // 7. Event Listeners
  // =========================================================================

  function bindHorizontalSwipe(el, onSwipeLeft, onSwipeRight) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    el.addEventListener(
      "touchstart",
      (ev) => {
        if (
          ev.touches.length !== 1 ||
          (ev.target && ev.target.closest && ev.target.closest(".hero-controls-bar"))
        ) {
          tracking = false;
          return;
        }
        startX = ev.touches[0].clientX;
        startY = ev.touches[0].clientY;
        tracking = true;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchend",
      (ev) => {
        if (!tracking || ev.changedTouches.length !== 1) return;
        tracking = false;
        const dx = ev.changedTouches[0].clientX - startX;
        const dy = ev.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.35) {
          if (dx < 0) onSwipeLeft();
          else onSwipeRight();
        }
      },
      { passive: true }
    );
  }

  function bindEvents() {
    dom.btnExplore.addEventListener("click", () => {
      const targetTop = dom.heroStage ? dom.heroStage.offsetHeight : 0;
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    });

    [dom.filterAll, dom.filterHighlights, dom.filterFavorites].forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.filter === btn.dataset.filter) return;
        state.filter = btn.dataset.filter;
        state.visibleCount = PAGE_BATCH_SIZE;
        state.activeDate = null;
        syncUrlParams();
        renderGallery();
      });
    });

    dom.btnLoadMore.addEventListener("click", () => {
      const total = getFilteredPhotos().length;
      state.visibleCount = Math.min(total, state.visibleCount + PAGE_BATCH_SIZE);
      renderGallery();
    });

    dom.btnThemeToggle.addEventListener("click", () => {
      const next = dom.html.getAttribute("data-theme") === "dark" ? "light" : "dark";
      dom.html.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEYS.theme, next);
      } catch (_) {}
    });

    dom.btnBackTop.addEventListener("click", () => {
      suppressScrollObserversUntil = performance.now() + 750;
      if (state.chapters.length > 0) {
        state.activeDate = state.chapters[0].date;
        highlightActiveDateUI(state.activeDate, true);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      scheduleHydrationAfterJump(500);
    });

    dom.heroStage.addEventListener("pointermove", (ev) => {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      const x = ev.clientX;
      const y = ev.clientY;
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      proximityRaf = requestAnimationFrame(() => updateHeroDotsProximity(x, y));
    });

    dom.heroStage.addEventListener("pointerleave", () => {
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      resetHeroDotsProximity();
    });

    let activeDotsPointerId = null;

    dom.heroDots.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      ev.stopPropagation();
      if (ev.cancelable) ev.preventDefault();
      activeDotsPointerId = ev.pointerId;
      lastHeroDotsTouchTime = performance.now();
      try {
        dom.heroDots.setPointerCapture(ev.pointerId);
      } catch (_) {}
      selectHeroDotAtTouchX(ev.clientX);
    });

    dom.heroDots.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== activeDotsPointerId || ev.pointerType === "mouse") return;
      lastHeroDotsTouchTime = performance.now();
      selectHeroDotAtTouchX(ev.clientX);
    });

    const endDotsTouch = (ev) => {
      if (ev.pointerId !== activeDotsPointerId) return;
      activeDotsPointerId = null;
      lastHeroDotsTouchTime = performance.now();
      resetHeroDotsProximity();
    };
    dom.heroDots.addEventListener("pointerup", endDotsTouch);
    dom.heroDots.addEventListener("pointercancel", endDotsTouch);

    bindHorizontalSwipe(
      dom.heroShowcase,
      () => {
        lastHeroSwipeTime = performance.now();
        setActiveHeroSlide(state.heroSlideIdx + 1);
        restartHeroSlideshow();
      },
      () => {
        lastHeroSwipeTime = performance.now();
        setActiveHeroSlide(state.heroSlideIdx - 1);
        restartHeroSlideshow();
      }
    );

    dom.lbBtnClose.addEventListener("click", closeLightbox);
    dom.lbPrev.addEventListener("click", () => stepLightbox(-1));
    dom.lbNext.addEventListener("click", () => stepLightbox(1));

    dom.lbBtnZoom.addEventListener("click", () => setLightboxZoom(!state.lightboxZoomed));
    dom.lbImgWrap.addEventListener("click", (ev) => {
      const nextZoom = !state.lightboxZoomed;
      if (nextZoom) {
        const rect = dom.lbImg.getBoundingClientRect();
        const xPct = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100;
        const yPct = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100;
        dom.lbImg.style.transformOrigin = `${xPct.toFixed(1)}% ${yPct.toFixed(1)}%`;
      }
      setLightboxZoom(nextZoom);
    });

    dom.lbImgWrap.addEventListener("mousemove", (ev) => {
      if (!state.lightboxZoomed) return;
      const rect = dom.lbImgWrap.getBoundingClientRect();
      const xPct = Math.min(
        100,
        Math.max(0, ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100)
      );
      const yPct = Math.min(
        100,
        Math.max(0, ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100)
      );
      dom.lbImg.style.transformOrigin = `${xPct.toFixed(1)}% ${yPct.toFixed(1)}%`;
    });

    bindHorizontalSwipe(
      dom.lbStage,
      () => {
        if (!state.lightboxZoomed) stepLightbox(1);
      },
      () => {
        if (!state.lightboxZoomed) stepLightbox(-1);
      }
    );

    dom.lbBtnFav.addEventListener("click", () => {
      const photo = state.lightboxList[state.lightboxIdx];
      if (photo) togglePhotoFavorite(photo.id);
    });

    dom.lbStage.addEventListener("click", (ev) => {
      if (ev.target === dom.lbStage) closeLightbox();
    });

    window.addEventListener("keydown", (ev) => {
      if (!state.lightboxOpen) return;
      if (ev.key === "Escape") closeLightbox();
      else if (ev.key === "ArrowLeft") stepLightbox(-1);
      else if (ev.key === "ArrowRight") stepLightbox(1);
      else if (ev.key === "z" || ev.key === "Z") setLightboxZoom(!state.lightboxZoomed);
      else if (ev.key === "f" || ev.key === "F") {
        const p = state.lightboxList[state.lightboxIdx];
        if (p) togglePhotoFavorite(p.id);
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          syncScrubberVisibility();
          updateActiveChapterFromScroll();
          schedulePumpHydration();
        });
      },
      { passive: true }
    );

    const galleryRo = new ResizeObserver(() => {
      syncScrubberVisibility();
      if (!state.photos.length) return;
      const nextOrient = getDesiredHeroOrientation();
      if (lastHeroOrientation && nextOrient !== lastHeroOrientation) {
        state.heroSlideIdx = 0;
        renderHeroCover();
      }
      const w = getContainerInnerWidth();
      if (Math.abs(w - lastContainerWidth) > 2) {
        renderGallery();
      }
    });
    galleryRo.observe(dom.galleryMain);
    if (dom.heroStage) galleryRo.observe(dom.heroStage);

    if (dom.galleryNav) {
      const navRo = new ResizeObserver(() => {
        syncNavHeight();
      });
      navRo.observe(dom.galleryNav);
    }
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================

  function applyCollectionHeader(collection) {
    if (!collection) return;
    const hasTitle = Boolean(collection.title);
    const hasSub = Boolean(collection.subtitle);
    const hasCurator = Boolean(collection.curator);

    if (hasTitle) {
      document.title = collection.title;
      dom.collectionTitle.textContent = collection.title;
      dom.collectionTitle.hidden = false;
    }
    if (hasSub) {
      dom.collectionSubtitle.textContent = collection.subtitle;
      dom.collectionSubtitle.hidden = false;
    }
    if (hasCurator) {
      dom.collectionEyebrow.textContent = collection.curator;
      dom.collectionEyebrow.hidden = false;
      dom.footerCopyright.textContent = `© ${collection.curator}`;
      dom.footerCopyright.hidden = false;
      dom.footer.classList.add("has-credit");
    }

    if (hasTitle || hasSub || hasCurator) {
      dom.heroCopy.hidden = false;
      dom.heroStage.classList.add("has-copy");
    }
  }

  function mergeManifestEnrichments(remoteManifest, baseManifest) {
    if (!remoteManifest || !Array.isArray(remoteManifest.photos)) return baseManifest;
    if (!baseManifest || !Array.isArray(baseManifest.photos)) return remoteManifest;

    const baseById = new Map();
    for (const bp of baseManifest.photos) {
      if (bp && bp.id) baseById.set(bp.id, bp);
    }

    for (const rp of remoteManifest.photos) {
      const bp = rp && baseById.get(rp.id);
      if (!bp) continue;
      if (!Array.isArray(rp.focalPoint) && Array.isArray(bp.focalPoint)) {
        rp.focalPoint = bp.focalPoint;
      }
      if (typeof rp.rating !== "number" && typeof bp.rating === "number") {
        rp.rating = bp.rating;
      }
    }
    return remoteManifest;
  }

  async function loadManifest() {
    if (window.__EMBEDDED_MANIFEST__) {
      return window.__EMBEDDED_MANIFEST__;
    }
    const localRes = await fetch("./manifest.json");
    if (!localRes.ok) {
      throw new Error(`Failed to fetch manifest (${localRes.status})`);
    }
    const baseManifest = await localRes.json();
    const remoteUrl = baseManifest.collection && baseManifest.collection.remoteManifestUrl;
    if (remoteUrl) {
      try {
        const remoteRes = await fetch(remoteUrl, { cache: "no-cache" });
        if (remoteRes.ok) {
          const remoteManifest = await remoteRes.json();
          return mergeManifestEnrichments(remoteManifest, baseManifest);
        }
      } catch (_) {}
    }
    return baseManifest;
  }

  async function init() {
    loadPersistedState();
    setupObservers();
    bindEvents();

    try {
      const manifest = await loadManifest();
      state.manifest = manifest;
      state.photos = [...(manifest.photos || [])].sort(
        (a, b) =>
          String(b.timestamp || "").localeCompare(String(a.timestamp || "")) ||
          String(b.id || "").localeCompare(String(a.id || ""))
      );
      state.chapters = [...(manifest.chapters || [])].sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || ""))
      );
      state.assetBaseUrl =
        (manifest.collection && manifest.collection.assetBaseUrl) || "./3k_exports";

      applyCollectionHeader(manifest.collection);
      renderHeroCover();
      renderGallery();
      checkSentinelIfVisible();
    } catch (_) {
      dom.chaptersContainer.innerHTML = `
        <div class="empty-state">
          <h3>Gallery unavailable</h3>
          <p>Unable to load the photograph manifest.</p>
        </div>
      `;
    }
  }

  init();
})();
