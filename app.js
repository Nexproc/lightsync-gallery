/**
 * Lightsync Gallery — Single-Page Photograph Viewer
 * - Aspect-preserving editorial spreads & justified row solver
 * - Cursor-proximity 2x magnification on hero carousel selectors
 * - Progressive blur-up placeholders + IntersectionObserver lazy hydration
 * - Automatic chunked pagination & optional date navigation
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
    btnCopyFavorites: document.getElementById("btn-copy-favorites"),
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

    toast: document.getElementById("toast-banner"),
  };

  let imgObserver = null;
  let sentinelObserver = null;
  let chapterSpyObserver = null;
  let toastTimer = null;
  let proximityRaf = 0;
  let lastContainerWidth = 0;

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

  function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove("is-visible"), 2200);
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

  function updateToolbarCounts() {
    const favCount = state.favorites.size;

    dom.filterAll.textContent = state.photos.length > 0 ? `All (${state.photos.length})` : "All";
    dom.filterHighlights.textContent = "Highlights";
    dom.filterFavorites.textContent = favCount > 0 ? `Favorites (${favCount})` : "Favorites";

    dom.filterAll.classList.toggle("is-active", state.filter === "all");
    dom.filterHighlights.classList.toggle("is-active", state.filter === "highlights");
    dom.filterFavorites.classList.toggle("is-active", state.filter === "favorites");

    dom.btnCopyFavorites.hidden = favCount === 0;
  }

  // =========================================================================
  // 1. Hero Carousel & 2x Cursor-Proximity Selector Magnification
  // =========================================================================

  function pickCarouselSlides() {
    const landscapes = state.photos.filter((p) => p.hero && p.orientation === "landscape");
    const pool =
      landscapes.length > 0
        ? landscapes
        : state.photos.filter((p) => p.orientation === "landscape");
    const source = pool.length > 0 ? pool : state.photos;

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

  function renderHeroCover() {
    state.heroPhotos = pickCarouselSlides();

    if (state.heroSlideIdx >= state.heroPhotos.length) {
      state.heroSlideIdx = 0;
    }

    dom.heroSlidesLayer.innerHTML = "";
    dom.heroDots.innerHTML = "";

    state.heroPhotos.forEach((photo, idx) => {
      const slide = document.createElement("div");
      slide.className = `hero-slide${idx === state.heroSlideIdx ? " is-active" : ""}`;
      slide.style.backgroundColor = photo.dominantColor || "#141210";

      const img = document.createElement("img");
      img.src = resolvePhotoUrl(photo);
      img.alt = photo.filename;
      img.decoding = "async";
      img.addEventListener("load", () => state.hydratedIds.add(photo.id));
      img.addEventListener("click", () => openLightboxByPhotoId(photo.id));

      slide.appendChild(img);
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
        setActiveHeroSlide(idx);
        restartHeroSlideshow();
      });

      dom.heroDots.appendChild(dot);
    });

    restartHeroSlideshow();
  }

  function setActiveHeroSlide(nextIdx) {
    const count = state.heroPhotos.length;
    if (!count) return;
    state.heroSlideIdx = (nextIdx + count) % count;

    const slides = dom.heroSlidesLayer.querySelectorAll(".hero-slide");
    slides.forEach((el, idx) => el.classList.toggle("is-active", idx === state.heroSlideIdx));

    const dots = dom.heroDots.querySelectorAll(".hero-dot");
    dots.forEach((dot, idx) => {
      const active = idx === state.heroSlideIdx;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-selected", active ? "true" : "false");
    });
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

  function resetHeroDotsProximity() {
    dom.heroDots.querySelectorAll(".hero-dot").forEach((dot) => {
      dot.style.setProperty("--prox", "0");
    });
  }

  // =========================================================================
  // 2. Date Navigation & Timeline Scrubber (Shown Only When 2+ Dates Exist)
  // =========================================================================

  function renderDateNavigation(filteredPhotos) {
    dom.dateChaptersNav.innerHTML = "";
    dom.timelineScrubber.innerHTML = "";

    const countsByDate = new Map();
    for (const p of filteredPhotos) {
      countsByDate.set(p.date, (countsByDate.get(p.date) || 0) + 1);
    }

    const activeChapters = state.chapters.filter((ch) => countsByDate.has(ch.date));
    if (activeChapters.length <= 1) {
      dom.dateChaptersNav.hidden = true;
      dom.timelineScrubber.hidden = true;
      return;
    }

    dom.dateChaptersNav.hidden = false;
    dom.timelineScrubber.hidden = false;

    activeChapters.forEach((ch, idx) => {
      const isCurrent = state.activeDate ? state.activeDate === ch.date : idx === 0;

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

  function jumpToDateChapter(dateKey) {
    const filtered = getFilteredPhotos();
    const firstIdx = filtered.findIndex((p) => p.date === dateKey);
    if (firstIdx === -1) return;

    const minNeeded = Math.min(filtered.length, firstIdx + PAGE_BATCH_SIZE);
    if (state.visibleCount < minNeeded) {
      state.visibleCount = minNeeded;
      renderGallery();
    }

    state.activeDate = dateKey;
    highlightActiveDateUI(dateKey);

    requestAnimationFrame(() => {
      const section = document.getElementById(`chapter-${dateKey}`);
      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function highlightActiveDateUI(dateKey) {
    dom.dateChaptersNav.querySelectorAll(".nav-pill").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.date === dateKey);
    });
    dom.timelineScrubber.querySelectorAll(".scrubber-tick").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.date === dateKey);
    });
  }

  // =========================================================================
  // 3. Aspect-Preserving Auto-Layout Engine (Hero Spreads + Justified Rows)
  // =========================================================================

  function getContainerInnerWidth() {
    const rect = dom.chaptersContainer.getBoundingClientRect();
    if (rect.width > 80) return Math.floor(rect.width);
    return Math.min(1400, Math.max(300, window.innerWidth - 64));
  }

  function getTargetRowHeight(containerWidth) {
    if (containerWidth < 560) return 230;
    if (containerWidth < 900) return 300;
    return 390;
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
        blocks.push({
          type: "row",
          items: row.map((item) => ({
            photo: item,
            width: item.aspect * naturalH,
            height: naturalH,
          })),
        });
        row = [];
        aspectSum = 0;
      } else if (isLast) {
        const clampedH = Math.min(naturalH, maxSingleH);
        blocks.push({
          type: "row",
          items: row.map((item) => ({
            photo: item,
            width: item.aspect * clampedH,
            height: clampedH,
          })),
        });
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
  // 4. Photo Cards & Lazy Hydration
  // =========================================================================

  function createPhotoCard(photo, widthPx, heightPx) {
    const figure = document.createElement("figure");
    figure.className = "photo-card";
    figure.style.margin = "0";
    figure.style.setProperty("--tile-bg", photo.dominantColor || "#1c1917");
    figure.style.width = `${widthPx.toFixed(2)}px`;
    figure.style.height = `${heightPx.toFixed(2)}px`;

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

    if (state.hydratedIds.has(photo.id)) {
      hiImg.src = resolvePhotoUrl(photo);
      figure.classList.add("is-loaded");
    } else if (imgObserver) {
      imgObserver.observe(hiImg);
    }

    figure.appendChild(hiImg);

    const overlay = document.createElement("div");
    overlay.className = "card-overlay";

    const topActions = document.createElement("div");
    topActions.className = "card-top-actions";

    const isFav = state.favorites.has(photo.id);
    const btnFav = document.createElement("button");
    btnFav.type = "button";
    btnFav.className = `card-action-btn${isFav ? " is-fav" : ""}`;
    btnFav.title = isFav ? "Remove from Favorites" : "Save to Favorites";
    btnFav.textContent = isFav ? "♥" : "♡";
    btnFav.addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePhotoFavorite(photo.id, btnFav);
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

    return figure;
  }

  function hydrateImageElement(imgEl) {
    const photoId = imgEl.dataset.photoId;
    if (!photoId || imgEl.getAttribute("src")) return;
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return;

    imgEl.src = resolvePhotoUrl(photo);
    const reveal = () => {
      const card = imgEl.closest(".photo-card");
      if (card) card.classList.add("is-loaded");
      state.hydratedIds.add(photoId);
    };

    if (typeof imgEl.decode === "function") {
      imgEl.decode().then(reveal).catch(reveal);
    } else {
      imgEl.addEventListener("load", reveal, { once: true });
    }
  }

  function setupObservers() {
    if (imgObserver) imgObserver.disconnect();
    imgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            imgObserver.unobserve(entry.target);
            hydrateImageElement(entry.target);
          }
        }
      },
      { rootMargin: "360px 0px" }
    );

    if (sentinelObserver) sentinelObserver.disconnect();
    sentinelObserver = new IntersectionObserver(
      (entries) => {
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
      { rootMargin: "360px 0px" }
    );
    sentinelObserver.observe(dom.paginationSentinel);
  }

  function setupChapterScrollSpy() {
    if (chapterSpyObserver) chapterSpyObserver.disconnect();
    chapterSpyObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const dKey = visible[0].target.dataset.date;
          if (dKey && dKey !== state.activeDate) {
            state.activeDate = dKey;
            highlightActiveDateUI(dKey);
          }
        }
      },
      { rootMargin: "-18% 0px -62% 0px", threshold: 0 }
    );

    dom.chaptersContainer.querySelectorAll(".date-chapter").forEach((sec) => {
      chapterSpyObserver.observe(sec);
    });
  }

  // =========================================================================
  // 5. Render Gallery Grid (Date Dividers Only When Multiple Dates Exist)
  // =========================================================================

  function buildBlocksDOM(blocks) {
    const rowsWrap = document.createElement("div");
    rowsWrap.className = "chapter-rows";

    for (const block of blocks) {
      if (block.type === "spread") {
        const spreadEl = document.createElement("div");
        spreadEl.className = "editorial-spread";

        const heroCard = createPhotoCard(
          block.heroItem.photo,
          block.heroItem.width,
          block.heroItem.height
        );

        const stackEl = document.createElement("div");
        stackEl.className = "spread-stack";
        stackEl.style.width = `${block.stackWidth.toFixed(2)}px`;
        for (const sItem of block.stackItems) {
          stackEl.appendChild(createPhotoCard(sItem.photo, sItem.width, sItem.height));
        }

        if (block.heroOnRight) {
          spreadEl.append(stackEl, heroCard);
        } else {
          spreadEl.append(heroCard, stackEl);
        }
        rowsWrap.appendChild(spreadEl);
      } else {
        const rowEl = document.createElement("div");
        rowEl.className = "gallery-row";
        for (const rItem of block.items) {
          rowEl.appendChild(createPhotoCard(rItem.photo, rItem.width, rItem.height));
        }
        rowsWrap.appendChild(rowEl);
      }
    }

    return rowsWrap;
  }

  function renderGallery() {
    const filtered = getFilteredPhotos();
    updateToolbarCounts();
    renderDateNavigation(filtered);

    dom.chaptersContainer.innerHTML = "";

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `
        <h3>No saved favorites yet</h3>
        <p>Click ♡ on any photograph to add it to your favorites.</p>
      `;
      dom.chaptersContainer.appendChild(empty);
      dom.btnLoadMore.hidden = true;
      return;
    }

    const visibleSlice = filtered.slice(0, state.visibleCount);
    const containerWidth = getContainerInnerWidth();
    lastContainerWidth = containerWidth;
    const gutter = 12;

    const totalDistinctDates = new Set(filtered.map((p) => p.date)).size;

    if (totalDistinctDates <= 1) {
      const blocks = solveAutoLayout(visibleSlice, containerWidth, gutter);
      dom.chaptersContainer.appendChild(buildBlocksDOM(blocks));
    } else {
      for (const ch of state.chapters) {
        const chPhotos = visibleSlice.filter((p) => p.date === ch.date);
        if (chPhotos.length === 0) continue;

        const totalInDate = filtered.filter((p) => p.date === ch.date).length;

        const section = document.createElement("section");
        section.className = "date-chapter";
        section.id = `chapter-${ch.date}`;
        section.dataset.date = ch.date;

        const header = document.createElement("div");
        header.className = "chapter-header";

        const dateSpan = document.createElement("span");
        dateSpan.className = "chapter-date-tag";
        dateSpan.textContent = ch.fullDate || ch.date;

        const countSpan = document.createElement("span");
        countSpan.className = "chapter-count-tag";
        countSpan.textContent = `${totalInDate}`;

        header.append(dateSpan, countSpan);
        section.appendChild(header);

        const blocks = solveAutoLayout(chPhotos, containerWidth, gutter);
        section.appendChild(buildBlocksDOM(blocks));
        dom.chaptersContainer.appendChild(section);
      }
      setupChapterScrollSpy();
    }

    dom.btnLoadMore.hidden = visibleSlice.length >= filtered.length;
  }

  // =========================================================================
  // 6. Favorites & Lightbox
  // =========================================================================

  function togglePhotoFavorite(photoId, cardBtn = null) {
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return;

    if (state.favorites.has(photoId)) {
      state.favorites.delete(photoId);
    } else {
      state.favorites.add(photoId);
    }
    saveFavorites();

    if (state.filter === "favorites") {
      renderGallery();
    } else {
      if (cardBtn) {
        const fav = state.favorites.has(photoId);
        cardBtn.classList.toggle("is-fav", fav);
        cardBtn.textContent = fav ? "♥" : "♡";
      }
      updateToolbarCounts();
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
    dom.lbBtnZoom.textContent = zoomed ? "⊖ Fit" : "⊕ Zoom";
    if (!zoomed) {
      dom.lbImg.style.transformOrigin = "center center";
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

    dom.lbFilmstrip.querySelectorAll(".lb-thumb").forEach((t, idx) => {
      const active = idx === state.lightboxIdx;
      t.classList.toggle("is-active", active);
      if (active) {
        t.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
    });
  }

  function syncLightboxControls() {
    const photo = state.lightboxList[state.lightboxIdx];
    if (!photo) return;
    const isFav = state.favorites.has(photo.id);
    dom.lbBtnFav.classList.toggle("is-active", isFav);
    dom.lbBtnFav.textContent = isFav ? "♥ Favorited" : "♡ Favorite";
  }

  function renderLightboxFilmstrip() {
    dom.lbFilmstrip.innerHTML = "";
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

  function bindEvents() {
    dom.btnExplore.addEventListener("click", () => {
      dom.galleryNav.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    [dom.filterAll, dom.filterHighlights, dom.filterFavorites].forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter;
        state.visibleCount = PAGE_BATCH_SIZE;
        syncUrlParams();
        renderGallery();
      });
    });

    dom.btnLoadMore.addEventListener("click", () => {
      const total = getFilteredPhotos().length;
      state.visibleCount = Math.min(total, state.visibleCount + PAGE_BATCH_SIZE);
      renderGallery();
    });

    dom.btnCopyFavorites.addEventListener("click", async () => {
      const picks = state.photos
        .filter((p) => state.favorites.has(p.id))
        .map((p) => p.filename);
      const summary = picks.join("\n");
      try {
        await navigator.clipboard.writeText(summary);
        showToast(`Copied ${picks.length} filenames to clipboard`);
      } catch (_) {
        showToast(`${picks.length} favorites saved`);
      }
    });

    dom.btnThemeToggle.addEventListener("click", () => {
      const next = dom.html.getAttribute("data-theme") === "dark" ? "light" : "dark";
      dom.html.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEYS.theme, next);
      } catch (_) {}
    });

    dom.btnBackTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    dom.heroStage.addEventListener("pointermove", (ev) => {
      const x = ev.clientX;
      const y = ev.clientY;
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      proximityRaf = requestAnimationFrame(() => updateHeroDotsProximity(x, y));
    });

    dom.heroStage.addEventListener("pointerleave", () => {
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      resetHeroDotsProximity();
    });

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
      const xPct = Math.min(100, Math.max(0, ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100));
      const yPct = Math.min(100, Math.max(0, ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100));
      dom.lbImg.style.transformOrigin = `${xPct.toFixed(1)}% ${yPct.toFixed(1)}%`;
    });

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

    const ro = new ResizeObserver(() => {
      const w = getContainerInnerWidth();
      if (Math.abs(w - lastContainerWidth) > 6) {
        renderGallery();
      }
    });
    ro.observe(dom.galleryMain);
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
          return await remoteRes.json();
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
      state.photos = manifest.photos || [];
      state.chapters = manifest.chapters || [];
      state.assetBaseUrl = (manifest.collection && manifest.collection.assetBaseUrl) || "./3k_exports";

      applyCollectionHeader(manifest.collection);
      renderHeroCover();
      renderGallery();
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
