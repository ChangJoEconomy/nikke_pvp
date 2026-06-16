(function () {
  "use strict";

  const SLOT_COUNT = 5;
  const MAX_PROCESS_WIDTH = 1400;
  const FEATURE_SIZE = 16;
  const TEMPLATE_CANDIDATE_COUNT = 48;
  const MATCH_RESULT_COUNT = 5;
  const PLUS_TEMPLATE_PATH = "./data/plus.png";
  const PLUS_MATCH_THRESHOLD = 0.86;
  const TIMELINE_MAX_FRAME = 600;
  const TIMELINE_DISPLAY_MAX_FRAME = 400;
  const RL_FRAME_UNIT = 76;
  const BURST_START_DELAY = 24;
  const BURST_CHAIN_DELAY = 32;
  const FULL_BURST_ENERGY = 100;
  const TIMELINE_KEY_MARKERS = [
    { frame: 76, label: "1RL", className: "rl" },
    { frame: 152, label: "2RL", className: "rl" },
    { frame: 228, label: "3RL", className: "rl" },
    { frame: 304, label: "4RL", className: "rl" },
    { frame: 380, label: "5RL", className: "rl" },
    { frame: 456, label: "6RL", className: "rl" }
  ];
  const TIMELINE_COLORS = ["#4fd1c5", "#ff7688", "#8b5cf6", "#f59e0b", "#22c55e"];
  const WEAPON_ICON_BY_CODE = {
    1: "sg",
    2: "rl",
    3: "sr",
    4: "ar",
    5: "smg",
    6: "mg"
  };
  const SHIFT_OFFSETS = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ];
  const INPUT_ROI_VARIANTS = [
    {
      name: "normal",
      portrait: { x: 0.00, y: 0.00, w: 1.00, h: 1.00 },
      upper: { x: 0.03, y: 0.02, w: 0.94, h: 0.72 },
      face: { x: 0.07, y: 0.00, w: 0.86, h: 0.52 }
    },
    {
      name: "high",
      portrait: { x: 0.00, y: 0.00, w: 1.00, h: 0.90 },
      upper: { x: 0.03, y: 0.00, w: 0.94, h: 0.66 },
      face: { x: 0.07, y: 0.00, w: 0.86, h: 0.46 }
    },
    {
      name: "low",
      portrait: { x: 0.00, y: 0.08, w: 1.00, h: 0.92 },
      upper: { x: 0.03, y: 0.10, w: 0.94, h: 0.70 },
      face: { x: 0.07, y: 0.08, w: 0.86, h: 0.50 }
    },
    {
      name: "tight",
      portrait: { x: 0.10, y: 0.00, w: 0.80, h: 0.92 },
      upper: { x: 0.12, y: 0.02, w: 0.76, h: 0.66 },
      face: { x: 0.16, y: 0.00, w: 0.68, h: 0.48 }
    },
    {
      name: "wide",
      portrait: { x: -0.05, y: 0.00, w: 1.10, h: 1.00 },
      upper: { x: -0.02, y: 0.02, w: 1.04, h: 0.72 },
      face: { x: 0.03, y: 0.00, w: 0.94, h: 0.52 }
    }
  ];

  const elements = {
    pasteZone: document.getElementById("pasteZone"),
    fileInput: document.getElementById("fileInput"),
    canvas: document.getElementById("previewCanvas"),
    canvasWrap: document.querySelector(".canvas-wrap"),
    emptyPreview: document.getElementById("emptyPreview"),
    recognized: document.getElementById("recognizedCharacters"),
    timeline: document.getElementById("burstTimeline"),
    results: null,
    status: null
  };

  const ctx = elements.canvas.getContext("2d", { willReadFrequently: true });
  let lastAnalysis = null;
  let nikkeGlobalData = [];
  let nikkeDataState = "loading";
  let plusTemplatePromise = null;
  let plusTemplate = null;
  let burstGaugeBackgroundVisible = true;

  function setStatus(text) {
    if (!elements.status) return;
    elements.status.textContent = text;
  }

  function showEmptyResults(message) {
    if (!elements.results) return;
    elements.results.innerHTML = `<div class="empty-results">${escapeHtml(message)}</div>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[ch]));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("이미지를 읽을 수 없습니다."));
      };
      image.src = url;
    });
  }

  async function handleImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("이미지 파일이 아닙니다");
      return;
    }

    try {
      setStatus("이미지 로딩 중");
      const image = await loadImageFromFile(file);
      await analyzeImage(image);
    } catch (error) {
      console.error(error);
      setStatus("분석 실패");
      showEmptyResults(error.message || "이미지를 분석하지 못했습니다.");
    }
  }

  async function handlePaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) {
      setStatus("클립보드에 이미지가 없습니다");
      return;
    }

    event.preventDefault();
    await handleImageFile(imageItem.getAsFile());
  }

  async function analyzeImage(image) {
    if (!Array.isArray(window.CHARACTERS) || window.CHARACTERS.length === 0) {
      setStatus("manifest 없음");
      showEmptyResults("data/characters.js에 캐릭터 descriptor가 없습니다. tools/generate-manifest.js를 먼저 실행하세요.");
      return;
    }

    const scale = Math.min(1, MAX_PROCESS_WIDTH / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    elements.canvas.width = width;
    elements.canvas.height = height;
    elements.canvasWrap?.classList.add("has-image");
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    elements.emptyPreview.style.display = "none";

    setStatus("카드 탐지 중");
    await nextFrame();
    const imageData = ctx.getImageData(0, 0, width, height);
    const cards = detectCards(imageData, width, height);

    setStatus("캐릭터 비교 중");
    await nextFrame();
    const plusIconTemplate = await loadPlusTemplate();
    const slots = cards.map((card, index) => {
      const desc = describeCard(imageData, width, height, card);
      const matches = findMatches(desc);
      const plusIcon = detectPlusIcon(imageData.data, width, height, card, plusIconTemplate);
      return { index, card, desc, matches, plusIcon };
    });

    lastAnalysis = { image, width, height, cards, slots };
    redrawAnalysis();
    renderRecognizedCharacters(slots);
    setStatus(cards.some((card) => card.fallback) ? "분석 완료 · fallback 포함" : "분석 완료");
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function loadPlusTemplate() {
    if (plusTemplate) return Promise.resolve(plusTemplate);
    if (plusTemplatePromise) return plusTemplatePromise;
    if (typeof Image !== "function") return Promise.resolve(null);

    plusTemplatePromise = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const templateCtx = canvas.getContext("2d", { willReadFrequently: true });
        templateCtx.drawImage(image, 0, 0);
        const imageData = templateCtx.getImageData(0, 0, canvas.width, canvas.height);
        const points = [];

        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const idx = (y * canvas.width + x) * 4;
            if (imageData.data[idx + 3] > 32) {
              points.push({
                x,
                y,
                r: imageData.data[idx],
                g: imageData.data[idx + 1],
                b: imageData.data[idx + 2]
              });
            }
          }
        }

        plusTemplate = points.length > 0
          ? { width: canvas.width, height: canvas.height, points }
          : null;
        resolve(plusTemplate);
      };
      image.onerror = () => {
        console.warn("data/plus.png를 읽지 못해 + 캐릭터 감지를 건너뜁니다.");
        resolve(null);
      };
      image.src = PLUS_TEMPLATE_PATH;
    });

    return plusTemplatePromise;
  }

  function detectPlusIcon(data, width, height, card, template) {
    if (!template || !template.points.length) return { detected: false, score: 0, x: 0, y: 0 };

    const x0 = clamp(Math.floor(card.x), 0, width - template.width);
    const x1 = clamp(Math.floor(card.x + card.w * 0.38), x0, width - template.width);
    const y0 = clamp(Math.floor(card.y + card.h * 0.35), 0, height - template.height);
    const y1 = clamp(Math.floor(card.y + card.h * 0.75), y0, height - template.height);
    let best = { score: -1, x: x0, y: y0 };

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const score = plusTemplateScore(data, width, x, y, template);
        if (score > best.score) best = { score, x, y };
      }
    }

    return {
      detected: best.score >= PLUS_MATCH_THRESHOLD,
      score: best.score,
      x: best.x,
      y: best.y
    };
  }

  function plusTemplateScore(data, width, x, y, template) {
    let sum = 0;
    let count = 0;

    template.points.forEach((point) => {
      const idx = ((y + point.y) * width + x + point.x) * 4;
      const dr = data[idx] - point.r;
      const dg = data[idx + 1] - point.g;
      const db = data[idx + 2] - point.b;
      sum += dr * dr + dg * dg + db * db;
      count += 3;
    });

    const rmse = Math.sqrt(sum / Math.max(1, count));
    return 1 - rmse / 255;
  }

  function detectCards(imageData, width, height) {
    const gray = buildGray(imageData.data, width, height);
    const bg = estimateBackground(imageData.data, width, height);
    const scanBottom = Math.max(1, Math.floor(height * 0.88));
    const colScore = new Array(width).fill(0);

    for (let y = 0; y < scanBottom; y += 1) {
      const row = y * width;
      for (let x = 1; x < width - 1; x += 1) {
        const idx = (row + x) * 4;
        const colorDistance =
          Math.abs(imageData.data[idx] - bg.r) +
          Math.abs(imageData.data[idx + 1] - bg.g) +
          Math.abs(imageData.data[idx + 2] - bg.b);
        const edge = Math.abs(gray[row + x] - gray[row + x - 1]) + Math.abs(gray[row + x] - gray[row + x + 1]);
        if (colorDistance > 38 || edge > 34) colScore[x] += 1;
      }
    }

    const smoothCols = smooth(colScore, Math.max(3, Math.round(width * 0.008)));
    const maxCol = Math.max(...smoothCols);
    const threshold = Math.max(4, maxCol * 0.18);
    const segments = toSegments(smoothCols, threshold, Math.max(3, Math.round(width * 0.006)))
      .map((seg) => ({ ...seg, score: sumRange(smoothCols, seg.start, seg.end), width: seg.end - seg.start + 1 }))
      .filter((seg) => seg.width >= Math.max(8, width * 0.025));

    let xSegments = chooseFiveSegments(segments, width);
    let method = "detected";

    if (xSegments.length !== SLOT_COUNT) {
      xSegments = fallbackSegments(smoothCols, width);
      method = "fallback";
    }

    return xSegments.map((seg, index) => {
      const yRange = detectCardY(gray, imageData.data, width, height, bg, seg.start, seg.end);
      const card = {
        x: clamp(seg.start, 0, width - 1),
        y: clamp(yRange.start, 0, height - 1),
        w: clamp(seg.end - seg.start + 1, 1, width),
        h: clamp(yRange.end - yRange.start + 1, 1, height),
        fallback: method === "fallback",
        slot: index + 1
      };
      card.art = refineArtRect(imageData.data, width, height, card);
      return card;
    });
  }

  function refineArtRect(data, width, height, card) {
    const base = {
      x: card.x + card.w * 0.12,
      y: card.y + card.h * 0.05,
      w: card.w * 0.76,
      h: card.h * 0.58
    };

    const minW = Math.max(8, card.w * 0.42);
    const minH = Math.max(12, card.h * 0.36);
    const trimmed = trimUiChrome(data, width, height, base, minW, minH);
    return clampRect(trimmed, width, height);
  }

  function trimUiChrome(data, width, height, rect, minW, minH) {
    const x0 = clamp(Math.floor(rect.x), 0, width - 1);
    const x1 = clamp(Math.ceil(rect.x + rect.w), x0 + 1, width);
    const y0 = clamp(Math.floor(rect.y), 0, height - 1);
    const y1 = clamp(Math.ceil(rect.y + rect.h), y0 + 1, height);
    const bg = sampleMedianColor(data, width, x0, y0, x1, y1);
    const colScore = [];
    const rowScore = [];

    for (let x = x0; x < x1; x += 1) {
      let active = 0;
      for (let y = y0; y < y1; y += 1) {
        if (isPortraitContent(data, width, x, y, bg)) active += 1;
      }
      colScore.push(active / Math.max(1, y1 - y0));
    }

    for (let y = y0; y < y1; y += 1) {
      let active = 0;
      for (let x = x0; x < x1; x += 1) {
        if (isPortraitContent(data, width, x, y, bg)) active += 1;
      }
      rowScore.push(active / Math.max(1, x1 - x0));
    }

    const left = firstAbove(colScore, 0.10);
    const right = lastAbove(colScore, 0.10);
    const top = firstAbove(rowScore, 0.10);
    const bottom = lastAbove(rowScore, 0.10);

    if (left === -1 || right === -1 || top === -1 || bottom === -1) return rect;

    const out = {
      x: x0 + left,
      y: y0 + top,
      w: right - left + 1,
      h: bottom - top + 1
    };

    if (out.w < minW || out.h < minH) return rect;
    return {
      x: Math.max(rect.x, out.x - rect.w * 0.02),
      y: Math.max(rect.y, out.y - rect.h * 0.02),
      w: Math.min(rect.x + rect.w, out.x + out.w + rect.w * 0.02) - Math.max(rect.x, out.x - rect.w * 0.02),
      h: Math.min(rect.y + rect.h, out.y + out.h + rect.h * 0.02) - Math.max(rect.y, out.y - rect.h * 0.02)
    };
  }

  function sampleMedianColor(data, width, x0, y0, x1, y1) {
    const colors = [];
    const stepX = Math.max(1, Math.floor((x1 - x0) / 5));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 5));
    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        const idx = (y * width + x) * 4;
        colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
      }
    }
    return {
      r: median(colors.map((c) => c.r)),
      g: median(colors.map((c) => c.g)),
      b: median(colors.map((c) => c.b))
    };
  }

  function isPortraitContent(data, width, x, y, bg) {
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const distance = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
    const goldUi = r > 150 && g > 95 && b < 80 && r - b > 70;
    const whiteUi = min > 220 && max - min < 24;
    const darkFrame = max < 36;
    return distance > 42 && !goldUi && !whiteUi && !darkFrame;
  }

  function firstAbove(values, threshold) {
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] >= threshold) return i;
    }
    return -1;
  }

  function lastAbove(values, threshold) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (values[i] >= threshold) return i;
    }
    return -1;
  }

  function chooseFiveSegments(segments, width) {
    if (segments.length === SLOT_COUNT) return segments.sort((a, b) => a.start - b.start);

    const plausible = segments
      .filter((seg) => seg.width <= width * 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .sort((a, b) => a.start - b.start);

    let best = null;
    for (let i = 0; i <= plausible.length - SLOT_COUNT; i += 1) {
      const group = plausible.slice(i, i + SLOT_COUNT);
      const widths = group.map((seg) => seg.width);
      const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
      const widthVariance = widths.reduce((acc, w) => acc + Math.abs(w - avgWidth), 0) / Math.max(1, avgWidth);
      const gaps = [];
      for (let j = 1; j < group.length; j += 1) gaps.push(group[j].start - group[j - 1].end);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
      const gapVariance = gaps.reduce((acc, gap) => acc + Math.abs(gap - avgGap), 0) / Math.max(1, avgGap);
      const score = group.reduce((acc, seg) => acc + seg.score, 0) - widthVariance * 2000 - gapVariance * 1200;
      if (!best || score > best.score) best = { group, score };
    }

    return best ? best.group : [];
  }

  function fallbackSegments(colScore, width) {
    const active = colScore
      .map((score, x) => ({ score, x }))
      .filter((item) => item.score > 0);
    const minX = active.length ? Math.min(...active.map((item) => item.x)) : 0;
    const maxX = active.length ? Math.max(...active.map((item) => item.x)) : width - 1;
    const span = Math.max(1, maxX - minX + 1);
    const slotWidth = span / SLOT_COUNT;
    return Array.from({ length: SLOT_COUNT }, (_, index) => ({
      start: Math.round(minX + slotWidth * index),
      end: Math.round(minX + slotWidth * (index + 1) - 1)
    }));
  }

  function detectCardY(gray, data, width, height, bg, startX, endX) {
    const rowScore = new Array(height).fill(0);
    const left = clamp(startX, 0, width - 1);
    const right = clamp(endX, left, width - 1);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = left; x <= right; x += 1) {
        const idx = (row + x) * 4;
        const colorDistance =
          Math.abs(data[idx] - bg.r) +
          Math.abs(data[idx + 1] - bg.g) +
          Math.abs(data[idx + 2] - bg.b);
        const edge = y > 0 ? Math.abs(gray[row + x] - gray[row - width + x]) : 0;
        if (colorDistance > 42 || edge > 38) rowScore[y] += 1;
      }
    }
    const smoothRows = smooth(rowScore, Math.max(2, Math.round(height * 0.01)));
    const maxRow = Math.max(...smoothRows);
    const threshold = Math.max(2, maxRow * 0.16);
    const segments = toSegments(smoothRows, threshold, Math.max(2, Math.round(height * 0.008)))
      .map((seg) => ({ ...seg, height: seg.end - seg.start + 1, score: sumRange(smoothRows, seg.start, seg.end) }))
      .filter((seg) => seg.height >= Math.max(12, height * 0.18));

    if (!segments.length) return { start: 0, end: Math.floor(height * 0.82) };
    return segments.sort((a, b) => b.score - a.score)[0];
  }

  function buildGray(data, width, height) {
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    return gray;
  }

  function estimateBackground(data, width, height) {
    const points = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
      [Math.floor(width / 2), height - 1]
    ];
    const colors = points.map(([x, y]) => {
      const idx = (y * width + x) * 4;
      return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
    });
    return {
      r: median(colors.map((c) => c.r)),
      g: median(colors.map((c) => c.g)),
      b: median(colors.map((c) => c.b))
    };
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function smooth(values, radius) {
    const out = new Array(values.length).fill(0);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i - radius - 1 >= 0) sum -= values[i - radius - 1];
      const from = Math.max(0, i - radius);
      const count = i - from + 1;
      out[i] = sum / count;
    }
    return out;
  }

  function toSegments(values, threshold, mergeGap) {
    const segments = [];
    let start = -1;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] >= threshold && start === -1) start = i;
      if ((values[i] < threshold || i === values.length - 1) && start !== -1) {
        const end = values[i] < threshold ? i - 1 : i;
        if (segments.length && start - segments[segments.length - 1].end <= mergeGap) {
          segments[segments.length - 1].end = end;
        } else {
          segments.push({ start, end });
        }
        start = -1;
      }
    }
    return segments;
  }

  function sumRange(values, start, end) {
    let sum = 0;
    for (let i = Math.max(0, start); i <= Math.min(values.length - 1, end); i += 1) sum += values[i];
    return sum;
  }

  function describeCard(imageData, width, height, card) {
    const variants = INPUT_ROI_VARIANTS.map((roi) => describeCardWithRoi(imageData, width, height, card, roi));
    return { ...variants[0], variants };
  }

  function describeCardWithRoi(imageData, width, height, card, roi) {
    const artRect = card.art || card;
    const portraitRect = rectFromRoi(artRect, roi.portrait);
    const upperRect = rectFromRoi(artRect, roi.upper);
    const faceRect = rectFromRoi(artRect, roi.face);
    return describeRects(imageData.data, width, height, roi.name, portraitRect, upperRect, faceRect);
  }

  function describeRects(data, width, height, name, portraitRect, upperRect, faceRect) {
    return {
      name,
      version: "feature-map-v1",
      parts: {
        portrait: featureMap(data, width, height, portraitRect, FEATURE_SIZE),
        upper: featureMap(data, width, height, upperRect, FEATURE_SIZE),
        face: featureMap(data, width, height, faceRect, FEATURE_SIZE)
      }
    };
  }

  function rectFromRoi(rect, roi) {
    return {
      x: rect.x + rect.w * roi.x,
      y: rect.y + rect.h * roi.y,
      w: rect.w * roi.w,
      h: rect.h * roi.h
    };
  }

  function clampRect(rect, width, height) {
    const x = clamp(rect.x, 0, width - 1);
    const y = clamp(rect.y, 0, height - 1);
    return {
      x,
      y,
      w: clamp(rect.w, 1, width - x),
      h: clamp(rect.h, 1, height - y)
    };
  }

  function featureMap(data, width, height, rect, size) {
    const l = [];
    const rg = [];
    const yb = [];
    const a = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const sx = clamp(Math.round(rect.x + ((x + 0.5) / size) * rect.w), 0, width - 1);
        const sy = clamp(Math.round(rect.y + ((y + 0.5) / size) * rect.h), 0, height - 1);
        const idx = (sy * width + sx) * 4;
        const alpha = data[idx + 3] / 255;
        const r = data[idx] * alpha + 255 * (1 - alpha);
        const g = data[idx + 1] * alpha + 255 * (1 - alpha);
        const b = data[idx + 2] * alpha + 255 * (1 - alpha);
        l.push(Math.round(r * 0.299 + g * 0.587 + b * 0.114));
        rg.push(Math.round(r - g));
        yb.push(Math.round((r + g) * 0.5 - b));
        a.push(Number(alpha.toFixed(3)));
      }
    }
    return { size, l, rg, yb, e: edgeMap(l, size), a };
  }

  function findMatches(desc) {
    const candidates = window.CHARACTERS
      .map((entry) => ({
        entry,
        score: quickScoreDescriptor(desc, entry.desc)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TEMPLATE_CANDIDATE_COUNT);

    return candidates
      .map((match) => ({
        entry: match.entry,
        score: scoreDescriptor(desc, match.entry.desc)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MATCH_RESULT_COUNT);
  }

  function quickScoreDescriptor(input, ref) {
    const inputVariants = input.variants || [input];
    const refVariants = ref.variants || [ref];
    let best = 0;
    for (const inputVariant of inputVariants) {
      for (const refVariant of refVariants) {
        if (inputVariant.version !== "feature-map-v1" || refVariant.version !== "feature-map-v1") continue;
        const upper = comparePartAtOffset(inputVariant.parts.upper, refVariant.parts.upper, 0, 0);
        const face = comparePartAtOffset(inputVariant.parts.face, refVariant.parts.face, 0, 0);
        best = Math.max(best, upper * 0.42 + face * 0.58);
      }
    }
    return best;
  }

  function scoreDescriptor(input, ref) {
    const inputVariants = input.variants || [input];
    const refVariants = ref.variants || [ref];
    let best = 0;
    for (const inputVariant of inputVariants) {
      for (const refVariant of refVariants) {
        best = Math.max(best, scoreSingleDescriptor(inputVariant, refVariant));
      }
    }
    return best;
  }

  function scoreSingleDescriptor(input, ref) {
    if (input.version !== "feature-map-v1" || ref.version !== "feature-map-v1") return 0;
    const portrait = comparePart(input.parts.portrait, ref.parts.portrait);
    const upper = comparePart(input.parts.upper, ref.parts.upper);
    const face = comparePart(input.parts.face, ref.parts.face);
    return clamp(portrait * 0.24 + upper * 0.34 + face * 0.42, 0, 1);
  }

  function comparePart(input, ref) {
    if (!input || !ref || input.size !== ref.size) return 0;
    let best = 0;
    for (const [dx, dy] of SHIFT_OFFSETS) {
      best = Math.max(best, comparePartAtOffset(input, ref, dx, dy));
    }
    return best;
  }

  function comparePartAtOffset(input, ref, dx, dy) {
    const l = centeredSimilarity(input.l, ref.l, ref.a, input.size, dx, dy);
    const rg = centeredSimilarity(input.rg, ref.rg, ref.a, input.size, dx, dy);
    const yb = centeredSimilarity(input.yb, ref.yb, ref.a, input.size, dx, dy);
    const e = edgeSimilarity(input.e, ref.e, ref.a, input.size, dx, dy);
    const silhouette = alphaCoverage(input.a, ref.a, input.size, dx, dy);
    return clamp(l * 0.34 + e * 0.28 + rg * 0.14 + yb * 0.14 + silhouette * 0.10, 0, 1);
  }

  function centeredSimilarity(input, ref, weights, size, dx, dy) {
    let weightSum = 0;
    let inputSum = 0;
    let refSum = 0;
    forEachShiftedCell(size, dx, dy, (inputIndex, refIndex) => {
      const weight = weights[refIndex];
      if (weight < 0.08) return;
      weightSum += weight;
      inputSum += input[inputIndex] * weight;
      refSum += ref[refIndex] * weight;
    });
    if (weightSum <= 0) return 0;

    const inputMean = inputSum / weightSum;
    const refMean = refSum / weightSum;
    let dot = 0;
    let inputNorm = 0;
    let refNorm = 0;
    forEachShiftedCell(size, dx, dy, (inputIndex, refIndex) => {
      const weight = weights[refIndex];
      if (weight < 0.08) return;
      const inputDelta = input[inputIndex] - inputMean;
      const refDelta = ref[refIndex] - refMean;
      dot += inputDelta * refDelta * weight;
      inputNorm += inputDelta * inputDelta * weight;
      refNorm += refDelta * refDelta * weight;
    });
    if (!inputNorm || !refNorm) return 0;
    return clamp((dot / Math.sqrt(inputNorm * refNorm) + 1) / 2, 0, 1);
  }

  function edgeSimilarity(input, ref, weights, size, dx, dy) {
    let dot = 0;
    let inputNorm = 0;
    let refNorm = 0;
    forEachShiftedCell(size, dx, dy, (inputIndex, refIndex) => {
      const weight = weights[refIndex];
      if (weight < 0.08) return;
      const inputValue = input[inputIndex];
      const refValue = ref[refIndex];
      dot += inputValue * refValue * weight;
      inputNorm += inputValue * inputValue * weight;
      refNorm += refValue * refValue * weight;
    });
    if (!inputNorm || !refNorm) return 0;
    return clamp(dot / Math.sqrt(inputNorm * refNorm), 0, 1);
  }

  function alphaCoverage(input, ref, size, dx, dy) {
    let overlap = 0;
    let refTotal = 0;
    forEachShiftedCell(size, dx, dy, (inputIndex, refIndex) => {
      const refAlpha = ref[refIndex];
      if (refAlpha < 0.08) return;
      overlap += Math.min(input[inputIndex], refAlpha);
      refTotal += refAlpha;
    });
    return refTotal ? clamp(overlap / refTotal, 0, 1) : 0;
  }

  function forEachShiftedCell(size, dx, dy, callback) {
    const xStart = Math.max(0, -dx);
    const xEnd = Math.min(size, size - dx);
    const yStart = Math.max(0, -dy);
    const yEnd = Math.min(size, size - dy);
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        callback((y + dy) * size + (x + dx), y * size + x);
      }
    }
  }

  function edgeMap(luma, size) {
    const out = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const here = luma[y * size + x];
        const right = x < size - 1 ? luma[y * size + x + 1] : here;
        const down = y < size - 1 ? luma[(y + 1) * size + x] : here;
        out.push(Math.round(Math.hypot(here - right, here - down)));
      }
    }
    return out;
  }

  function redrawAnalysis() {
    if (!lastAnalysis) return;
    const { image, width, height, slots } = lastAnalysis;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    ctx.lineWidth = Math.max(2, width / 500);
    ctx.font = `${Math.max(12, Math.round(width / 45))}px system-ui, sans-serif`;
    ctx.textBaseline = "top";

    slots.forEach((slot) => {
      const best = slot.matches[0];
      const label = best ? `${slot.index + 1}. ${best.entry.character} ${best.score.toFixed(2)}` : `${slot.index + 1}. ?`;
      drawRect(slot.card, slot.card.fallback ? "#c97909" : "#0f8f87");
      drawRect(slot.card.art || rectFromRoi(slot.card, INPUT_ROI_VARIANTS[0].portrait), "#f0b429");
      drawLabel(label, slot.card.x, Math.max(0, slot.card.y - 24));
    });
  }

  function drawRect(rect, color) {
    ctx.strokeStyle = color;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }

  function drawLabel(label, x, y) {
    const metrics = ctx.measureText(label);
    const pad = 6;
    const h = 22;
    ctx.fillStyle = "rgba(23, 32, 42, 0.86)";
    ctx.fillRect(x, y, metrics.width + pad * 2, h);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + pad, y + 4);
  }

  function renderRecognizedCharacters(slots) {
    if (!elements.recognized) return;
    if (!Array.isArray(slots) || slots.length === 0) {
      elements.recognized.innerHTML = `<div class="empty-results">분석 후 캐릭터 일러스트와 한글 이름이 표시됩니다.</div>`;
      renderBurstTimeline([]);
      return;
    }

    elements.recognized.innerHTML = slots.map((slot) => {
      const best = slot.matches[0];
      if (!best) {
        return `
          <article class="recognized-card is-empty">
            <div class="recognized-image"></div>
            <div class="recognized-name">확실하지 않음</div>
          </article>
        `;
      }

      const data = findGlobalCharacter(best.entry, slot.plusIcon?.detected);
      const koName = data?.name?.ko || data?.name?.en || best.entry.character;

      return `
        <article class="recognized-card" tabindex="0">
          <div class="recognized-image">
            <img src="${escapeHtml(best.entry.path)}" alt="${escapeHtml(koName)}">
            ${renderDetectedPlusIcon(slot.plusIcon?.detected)}
            ${renderAttributeIcons(data)}
          </div>
          <div class="recognized-name">${escapeHtml(koName)}</div>
        </article>
      `;
    }).join("");

    if (nikkeDataState === "error") {
      elements.recognized.insertAdjacentHTML(
        "beforeend",
        `<div class="empty-results">data/nikke_data.json을 읽지 못했습니다. 로컬 서버에서 실행 중인지 확인하세요.</div>`
      );
    }

    renderBurstTimeline(slots);
  }

  function renderAttributeIcons(data) {
    const icons = [
      attributeIcon("burst", data?.burst, `버스트 ${data?.burst}`),
      attributeIcon("weapon", WEAPON_ICON_BY_CODE[data?.weapon], "무기"),
      attributeIcon("element", data?.element, `속성 ${data?.element}`)
    ].filter(Boolean);

    return `
      <div class="recognized-icons" aria-label="캐릭터 속성">
        ${icons.join("")}
      </div>
    `;
  }

  function renderDetectedPlusIcon(detected) {
    if (!detected) return "";
    return `
      <div class="recognized-plus-icon" aria-label="플러스 감지">
        <img src="./img_src/plus/plus.png" alt="+">
      </div>
    `;
  }

  function attributeIcon(type, value, alt) {
    if (value === undefined || value === null || value === "") return "";
    const safeType = String(type).replace(/[^a-z]/g, "");
    const safeValue = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!safeType || !safeValue) return "";
    if (safeType === "burst" && !["0", "1", "2", "3"].includes(safeValue)) return "";
    if (safeType === "element" && !["1", "2", "3", "4", "5"].includes(safeValue)) return "";
    return `<img src="./img_src/${safeType}/${safeValue}.png" alt="${escapeHtml(alt)}">`;
  }

  function renderBurstTimeline(slots) {
    if (!elements.timeline) return;
    if (!Array.isArray(slots) || slots.length === 0) {
      elements.timeline.innerHTML = "";
      return;
    }

    if (!Array.isArray(nikkeGlobalData) || nikkeGlobalData.length === 0) {
      elements.timeline.innerHTML = `<div class="empty-results">버스트 충전 그래프를 계산하려면 data/nikke_data.json이 필요합니다.</div>`;
      return;
    }

    const rows = slots.map((slot, index) => {
      const best = slot.matches[0];
      if (!best) return null;
      const data = findGlobalCharacter(best.entry, slot.plusIcon?.detected);
      if (!data) return null;
      return {
        index,
        slot,
        entry: best.entry,
        data,
        name: data?.name?.ko || data?.name?.en || best.entry.character,
        path: best.entry.path,
        color: TIMELINE_COLORS[index % TIMELINE_COLORS.length],
        events: [],
        totalPercent: 0
      };
    }).filter(Boolean);

    if (rows.length === 0) {
      elements.timeline.innerHTML = `<div class="empty-results">버스트 충전 그래프를 계산할 캐릭터 데이터를 찾지 못했습니다.</div>`;
      return;
    }

    if (!window.NikkeChargeCore) {
      elements.timeline.innerHTML = `<div class="empty-results">nikke_charge_core.js를 읽지 못해 버스트 충전을 계산할 수 없습니다.</div>`;
      return;
    }

    const model = buildBurstTimelineModel(rows);
    elements.timeline.innerHTML = renderBurstTimelineHtml(model);
    attachBurstGaugeToggle();
    attachBurstTimelineHover(model);
  }

  function buildBurstTimelineModel(rows) {
    const core = window.NikkeChargeCore;
    const characters = Array.from({ length: SLOT_COUNT }, (_, index) => {
      const row = rows.find((item) => item.index === index);
      return row ? row.data : null;
    });
    const team = core.makeTeam(characters, { teamType: "attack" });
    const summary = core.summarizeTeam(team, null, TIMELINE_MAX_FRAME, FULL_BURST_ENERGY);
    const eventsBySource = new Map();

    summary.events.forEach((event) => {
      const sourceIndex = Number(event.sourcePosition);
      if (!eventsBySource.has(sourceIndex)) eventsBySource.set(sourceIndex, []);
      eventsBySource.get(sourceIndex).push({
        frame: event.frame,
        percent: event.charge
      });
    });

    rows.forEach((row) => {
      row.events = (eventsBySource.get(row.index) || []).map((event) => ({
        ...event,
        row
      }));
      row.totalPercent = 0;
    });

    const attackEvents = rows.flatMap((row) => row.events)
      .sort((a, b) => a.frame - b.frame || a.row.index - b.row.index);
    applyBurstFillContribution(attackEvents, rows);

    const gaugePoints = [{ frame: 0, gauge: 0 }].concat(summary.timeline.map((point) => ({
      frame: point.frame,
      gauge: clamp(point.totalCharge, 0, FULL_BURST_ENERGY)
    })));

    if (gaugePoints[gaugePoints.length - 1].frame < TIMELINE_MAX_FRAME) {
      gaugePoints.push({
        frame: TIMELINE_MAX_FRAME,
        gauge: gaugePoints[gaugePoints.length - 1].gauge
      });
    }

    const readyFrame = summary.burstReadyFrame;
    const burst1Frame = readyFrame === null ? null : readyFrame + BURST_START_DELAY;
    const burst2Frame = burst1Frame === null ? null : burst1Frame + BURST_CHAIN_DELAY;
    const burst3Frame = burst2Frame === null ? null : burst2Frame + BURST_CHAIN_DELAY;

    return {
      rows,
      attackEvents,
      gaugePoints,
      thresholdFrame: readyFrame,
      readyFrame,
      burst1Frame,
      burst2Frame,
      burst3Frame
    };
  }

  function applyBurstFillContribution(events, rows) {
    rows.forEach((row) => {
      row.totalPercent = 0;
    });

    let gauge = 0;
    events.forEach((event) => {
      if (gauge >= FULL_BURST_ENERGY) return;
      const contribution = Math.min(event.percent, FULL_BURST_ENERGY - gauge);
      gauge += contribution;
      event.row.totalPercent += contribution;
    });
  }

  function renderBurstTimelineHtml(model) {
    return `
      ${renderBurstReadySummary(model)}
      <section class="burst-chart" aria-label="버스트 충전 그래프">
        <div class="burst-chart-head">
          <h3>버스트 충전 타임라인</h3>
          ${renderBurstGaugeToggle()}
        </div>
        <div class="burst-chart-scroll">
          ${renderBurstTimelineSvg(model)}
        </div>
      </section>
    `;
  }

  function renderBurstReadySummary(model) {
    if (model.readyFrame === null) {
      return `
        <div class="burst-ready-summary">
          <strong>--RL</strong>
        </div>
      `;
    }

    return `
      <div class="burst-ready-summary">
        <strong>${formatRlValue(model.readyFrame)}RL</strong>
      </div>
    `;
  }

  function renderBurstGaugeToggle() {
    return `
      <label class="burst-gauge-toggle">
        <input type="checkbox" ${burstGaugeBackgroundVisible ? "checked" : ""}>
        <span class="burst-gauge-toggle-track" aria-hidden="true"></span>
        <span>배경 그래프</span>
      </label>
    `;
  }

  function renderBurstTimelineSvg(model) {
    const width = 1160;
    const left = 106;
    const right = 58;
    const top = 32;
    const rowTop = 56;
    const rowHeight = 48;
    const visibleRowCount = Math.max(model.rows.length, SLOT_COUNT);
    const stageGap = 18;
    const stageSpace = 56;
    const plotHeight = rowTop - top + visibleRowCount * rowHeight + stageSpace;
    const bottom = 24;
    const height = top + plotHeight + bottom;
    const maxFrame = TIMELINE_DISPLAY_MAX_FRAME;
    const plotWidth = width - left - right;
    const x = (frame) => left + (frame / maxFrame) * plotWidth;
    const yGauge = (value) => top + plotHeight - (clamp(value, 0, FULL_BURST_ENERGY) / FULL_BURST_ENERGY) * plotHeight;
    const rowY = (index) => rowTop + index * rowHeight + rowHeight / 2;
    const gaugePaths = buildGaugeSvgPaths(cropGaugePoints(model.gaugePoints, maxFrame), x, yGauge, maxFrame);
    const burstMarkers = [
      { frame: model.readyFrame, label: "Ready", color: "#38bdf8" },
      { frame: model.burst1Frame, label: "B1", color: "#22c55e" },
      { frame: model.burst2Frame, label: "B2", color: "#a78bfa" },
      { frame: model.burst3Frame, label: "B3", color: "#f97316" }
    ].filter((marker) => marker.frame !== null && marker.frame <= maxFrame);
    const burstTrackY = rowTop + visibleRowCount * rowHeight + stageGap;

    return `
      <svg class="burst-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="버스트 충전 타임라인">
        <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#202326"></rect>
        <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="#222426"></rect>
        <path d="${gaugePaths.fill}" class="burst-gauge-fill ${burstGaugeBackgroundVisible ? "" : "is-hidden"}"></path>
        <path d="${gaugePaths.line}" class="burst-gauge-line ${burstGaugeBackgroundVisible ? "" : "is-hidden"}"></path>
        ${[0, 50, 100].map((value) => `
          <line x1="${left}" x2="${width - right}" y1="${yGauge(value)}" y2="${yGauge(value)}" class="burst-grid-line"></line>
          <text x="${width - right + 8}" y="${yGauge(value) + 4}" class="burst-axis-label" text-anchor="start">${value}%</text>
        `).join("")}
        ${range(0, maxFrame, 50).map((frame) => `
          <line x1="${x(frame)}" x2="${x(frame)}" y1="${top}" y2="${top + plotHeight}" class="burst-frame-line"></line>
          <text x="${x(frame)}" y="${height - 12}" class="burst-axis-label" text-anchor="middle">${frame}</text>
        `).join("")}
        ${TIMELINE_KEY_MARKERS.map((marker) => `
          <line x1="${x(marker.frame)}" x2="${x(marker.frame)}" y1="${top - 2}" y2="${top + plotHeight}" class="burst-key-line ${marker.className}"></line>
          <text x="${x(marker.frame)}" y="18" class="burst-key-label" text-anchor="middle">${escapeHtml(marker.label)}</text>
        `).join("")}
        ${renderBurstStageBar(burstMarkers, { x, left, right, width, y: burstTrackY })}
        <text x="8" y="${rowTop - 20}" class="burst-row-header">
          <tspan x="8" dy="0">버스트</tspan>
          <tspan x="8" dy="12">충전량</tspan>
        </text>
        ${model.rows.map((row, index) => renderBurstTimelineRow(row, index, { x, rowY, left, width, right, maxFrame })).join("")}
        <g class="burst-hover-layer" style="display: none;">
          <line class="burst-hover-line" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotHeight}"></line>
          <circle class="burst-hover-dot" cx="${left}" cy="${yGauge(0)}" r="4"></circle>
          <rect class="burst-hover-box" x="${left + 8}" y="${top + 8}" width="92" height="34" rx="5"></rect>
          <text class="burst-hover-frame" x="${left + 16}" y="${top + 22}">0F</text>
          <text class="burst-hover-value" x="${left + 16}" y="${top + 36}">0%</text>
        </g>
        <rect class="burst-hover-capture" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"></rect>
        <text x="${left + plotWidth / 2}" y="${height - 2}" class="burst-axis-label" text-anchor="middle">Time (F)</text>
      </svg>
    `;
  }

  function attachBurstGaugeToggle() {
    const toggle = elements.timeline?.querySelector(".burst-gauge-toggle input");
    const svg = elements.timeline?.querySelector(".burst-svg");
    if (!toggle || !svg) return;

    toggle.addEventListener("change", () => {
      burstGaugeBackgroundVisible = toggle.checked;
      svg.querySelectorAll(".burst-gauge-fill, .burst-gauge-line").forEach((path) => {
        path.classList.toggle("is-hidden", !burstGaugeBackgroundVisible);
      });
    });
  }

  function renderBurstStageBar(markers, scale) {
    if (!markers.length) return "";

    const ready = markers[0];
    const points = markers.map((marker) => ({
      ...marker,
      x: scale.x(marker.frame)
    }));
    const labelOffsets = [-8, 15, -8, 15];
    const segments = [
      `<line x1="${scale.left}" x2="${points[0].x}" y1="${scale.y}" y2="${scale.y}" class="burst-stage-line"></line>`
    ];

    points.slice(0, -1).forEach((point, index) => {
      const next = points[index + 1];
      segments.push(`<line x1="${point.x}" x2="${next.x}" y1="${scale.y}" y2="${scale.y}" class="burst-stage-line is-chain"></line>`);
    });

    return `
      <g class="burst-stage-bar" aria-label="버스트 단계">
        <line x1="${scale.left}" x2="${scale.width - scale.right}" y1="${scale.y}" y2="${scale.y}" class="burst-stage-backdrop"></line>
        ${segments.join("")}
        ${points.map((point, index) => `
          <circle cx="${point.x}" cy="${scale.y}" r="5" fill="${point.color}" stroke="#202326" stroke-width="2"></circle>
          <text x="${point.x}" y="${scale.y + labelOffsets[index]}" fill="${point.color}" class="burst-stage-label" text-anchor="middle">${point.label} ${point.frame}F</text>
        `).join("")}
        <line x1="${ready.x}" x2="${ready.x}" y1="${scale.y - 8}" y2="${scale.y + 8}" class="burst-stage-ready-stop"></line>
      </g>
    `;
  }

  function attachBurstTimelineHover(model) {
    const svg = elements.timeline?.querySelector(".burst-svg");
    if (!svg) return;

    const hoverLayer = svg.querySelector(".burst-hover-layer");
    const hoverLine = svg.querySelector(".burst-hover-line");
    const hoverDot = svg.querySelector(".burst-hover-dot");
    const hoverBox = svg.querySelector(".burst-hover-box");
    const hoverFrame = svg.querySelector(".burst-hover-frame");
    const hoverValue = svg.querySelector(".burst-hover-value");
    if (!hoverLayer || !hoverLine || !hoverDot || !hoverBox || !hoverFrame || !hoverValue) return;

    const viewBox = svg.viewBox.baseVal;
    const left = 106;
    const right = 58;
    const top = 32;
    const bottom = 24;
    const maxFrame = TIMELINE_DISPLAY_MAX_FRAME;
    const plotWidth = viewBox.width - left - right;
    const plotHeight = viewBox.height - top - bottom;
    const maxX = left + plotWidth;
    const maxY = top + plotHeight;
    const xFromFrame = (frame) => left + (frame / maxFrame) * plotWidth;
    const yFromGauge = (value) => top + plotHeight - (clamp(value, 0, FULL_BURST_ENERGY) / FULL_BURST_ENERGY) * plotHeight;
    const gaugeAtFrame = (frame) => {
      let gauge = 0;
      model.gaugePoints.forEach((point) => {
        if (point.frame <= frame) gauge = point.gauge;
      });
      return gauge;
    };
    const hide = () => {
      hoverLayer.style.display = "none";
    };

    svg.addEventListener("mousemove", (event) => {
      const rect = svg.getBoundingClientRect();
      const svgX = ((event.clientX - rect.left) / rect.width) * viewBox.width;
      const svgY = ((event.clientY - rect.top) / rect.height) * viewBox.height;
      if (svgX < left || svgX > maxX || svgY < top || svgY > maxY) {
        hide();
        return;
      }

      const frame = clamp(Math.round(((svgX - left) / plotWidth) * maxFrame), 0, maxFrame);
      const gauge = gaugeAtFrame(frame);
      const x = xFromFrame(frame);
      const y = yFromGauge(gauge);
      const boxX = clamp(x + 10, left + 4, maxX - 96);
      const boxY = clamp(y - 42, top + 4, maxY - 38);

      hoverLayer.style.display = "";
      hoverLine.setAttribute("x1", x);
      hoverLine.setAttribute("x2", x);
      hoverDot.setAttribute("cx", x);
      hoverDot.setAttribute("cy", y);
      hoverBox.setAttribute("x", boxX);
      hoverBox.setAttribute("y", boxY);
      hoverFrame.setAttribute("x", boxX + 8);
      hoverFrame.setAttribute("y", boxY + 14);
      hoverFrame.textContent = `${frame}F`;
      hoverValue.setAttribute("x", boxX + 8);
      hoverValue.setAttribute("y", boxY + 28);
      hoverValue.textContent = `${formatNumber(gauge)}%`;
    });

    svg.addEventListener("mouseleave", hide);
  }

  function renderBurstTimelineRow(row, index, scale) {
    const y = scale.rowY(index);
    const clipId = `burst-face-${index}`;
    return `
      <line x1="${scale.left}" x2="${scale.width - scale.right}" y1="${y}" y2="${y}" stroke="${row.color}" stroke-width="1.5" opacity="0.9"></line>
      <defs>
        <clipPath id="${clipId}">
          <circle cx="82" cy="${y}" r="17"></circle>
        </clipPath>
      </defs>
      <text x="10" y="${y + 4}" class="burst-row-percent">${formatPercentOneDecimal(row.totalPercent)}%</text>
      <circle cx="82" cy="${y}" r="18" fill="#f8fafc" stroke="${row.color}" stroke-width="2"></circle>
      <image href="${escapeHtml(row.path)}" x="64" y="${y - 22}" width="36" height="48" preserveAspectRatio="xMidYMin slice" clip-path="url(#${clipId})"></image>
      ${row.events.filter((event) => event.frame <= scale.maxFrame).map((event) => `
        <circle cx="${scale.x(event.frame)}" cy="${y}" r="3.2" fill="${row.color}" stroke="#202326" stroke-width="1">
          <title>${escapeHtml(row.name)} ${event.frame}F ${formatNumber(event.percent)}%</title>
        </circle>
      `).join("")}
    `;
  }

  function cropGaugePoints(points, maxFrame) {
    if (!points.length) return [{ frame: 0, gauge: 0 }, { frame: maxFrame, gauge: 0 }];

    const cropped = [];
    let previous = points[0];

    points.forEach((point) => {
      if (point.frame <= maxFrame) {
        cropped.push(point);
        previous = point;
      }
    });

    if (cropped.length === 0 || cropped[0].frame > 0) {
      cropped.unshift({ frame: 0, gauge: 0 });
    }

    const last = cropped[cropped.length - 1];
    if (last.frame < maxFrame) {
      cropped.push({ frame: maxFrame, gauge: last.gauge });
    } else if (last.frame > maxFrame) {
      cropped[cropped.length - 1] = { frame: maxFrame, gauge: previous.gauge };
    }

    return cropped;
  }

  function buildGaugeSvgPaths(points, x, yGauge, maxFrame) {
    let line = `M ${x(0)} ${yGauge(0)}`;
    let fill = `M ${x(0)} ${yGauge(0)}`;
    let previous = points[0] || { frame: 0, gauge: 0 };

    points.slice(1).forEach((point) => {
      line += ` L ${x(point.frame)} ${yGauge(previous.gauge)} L ${x(point.frame)} ${yGauge(point.gauge)}`;
      fill += ` L ${x(point.frame)} ${yGauge(previous.gauge)} L ${x(point.frame)} ${yGauge(point.gauge)}`;
      previous = point;
    });

    fill += ` L ${x(maxFrame)} ${yGauge(0)} L ${x(0)} ${yGauge(0)} Z`;
    return { line, fill };
  }

  function range(start, end, step) {
    const out = [];
    for (let value = start; value <= end; value += step) out.push(value);
    return out;
  }

  function formatNumber(value) {
    return Number(value.toFixed(4)).toString();
  }

  function formatPercentOneDecimal(value) {
    return Number(value.toFixed(1)).toString();
  }

  function formatRlValue(frame) {
    return Number((frame / RL_FRAME_UNIT).toFixed(1)).toString();
  }

  function findGlobalCharacter(entry, plusDetected = false) {
    if (!entry || !Array.isArray(nikkeGlobalData) || nikkeGlobalData.length === 0) return null;
    const preferred = findGlobalCharacterByMode(entry, Boolean(plusDetected));
    if (preferred) return preferred;
    return plusDetected ? findGlobalCharacterByMode(entry, false) : null;
  }

  function findGlobalCharacterByMode(entry, plusDetected) {
    const candidates = buildGlobalNameCandidates(entry, plusDetected).map((name, index) => ({
      raw: name,
      normalized: normalizeLookupName(name),
      weight: 1 - index * 0.04
    })).filter((candidate) => candidate.normalized);
    const globalItems = nikkeGlobalData.filter((item) => isPlusGlobalName(item?.name?.en) === plusDetected);
    if (candidates.length === 0 || globalItems.length === 0) return null;

    for (const candidate of candidates) {
      for (const item of globalItems) {
        const en = normalizeLookupName(item?.name?.en);
        if (candidate.normalized && candidate.normalized === en) return item;
      }
    }

    let best = null;
    for (const item of globalItems) {
      const en = normalizeLookupName(item?.name?.en);
      const score = Math.max(...candidates.map((candidate) => nameScore(candidate.normalized, en) * candidate.weight));
      if (!best || score > best.score) best = { item, score };
    }
    return best && best.score >= 0.82 ? best.item : null;
  }

  function missingGlobalDataMessage(entry, plusDetected = false) {
    const target = `${entry.character} / ${entry.skin}`;
    if (nikkeDataState !== "ready" || !Array.isArray(nikkeGlobalData) || nikkeGlobalData.length === 0) {
      return `data/nikke_data.json을 아직 읽지 못함\n검색 대상: ${target}`;
    }
    const mode = plusDetected ? " + 감지 우선" : "기본";
    return `data/nikke_data.json의 global에서 찾지 못함\n검색 대상: ${target}\n검색 모드: ${mode}`;
  }

  function buildGlobalNameCandidates(entry, plusDetected = false) {
    const character = String(entry.character || "").trim();
    const skin = String(entry.skin || "default").trim();
    const rawSkin = normalizeSkinText(skin);
    const cleanSkin = cleanSkinName(skin);
    const names = [];

    if (plusDetected) {
      names.push(withPlusSuffix(character));
    }

    if (cleanSkin && cleanSkin.toLowerCase() !== "default") {
      names.push(`${character}: ${cleanSkin}`);
      names.push(`${character} ${cleanSkin}`);
    }

    if (rawSkin && rawSkin.toLowerCase() !== "default" && rawSkin !== cleanSkin) {
      names.push(`${character}: ${rawSkin}`);
      names.push(`${character} ${rawSkin}`);
    }

    names.push(character);

    const filtered = plusDetected
      ? names.map(withPlusSuffix)
      : names.filter((name) => !isPlusGlobalName(name));

    return Array.from(new Set(filtered.filter(Boolean)));
  }

  function withPlusSuffix(name) {
    const text = String(name || "").trim();
    if (!text) return "";
    return isPlusGlobalName(text) ? text : `${text} +`;
  }

  function isPlusGlobalName(name) {
    return /\+\s*$/.test(String(name || "").trim());
  }

  function normalizeSkinText(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanSkinName(value) {
    return normalizeSkinText(value)
      .replace(/^\((.*)\)$/g, "$1")
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeLookupName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\+/g, " plus ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function nameScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    const aTokens = new Set(a.split(" "));
    const bTokens = new Set(b.split(" "));
    let overlap = 0;
    aTokens.forEach((token) => {
      if (bTokens.has(token)) overlap += 1;
    });
    return overlap / Math.max(aTokens.size, bTokens.size, 1);
  }

  async function loadNikkeData() {
    try {
      if (window.NIKKE_DATA && Array.isArray(window.NIKKE_DATA.global)) {
        nikkeGlobalData = window.NIKKE_DATA.global;
        nikkeDataState = "ready";
        return;
      }

      if (typeof fetch !== "function") {
        nikkeDataState = "error";
        return;
      }

      const response = await fetch("./data/nikke_data.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`data/nikke_data.json ${response.status}`);
      const data = await response.json();
      nikkeGlobalData = Array.isArray(data.global) ? data.global : [];
      nikkeDataState = "ready";
    } catch (error) {
      console.error(error);
      nikkeGlobalData = [];
      nikkeDataState = "error";
    } finally {
      if (lastAnalysis) renderRecognizedCharacters(lastAnalysis.slots);
    }
  }

  elements.pasteZone.addEventListener("paste", handlePaste);
  elements.pasteZone.addEventListener("focus", () => elements.pasteZone.classList.add("is-active"));
  elements.pasteZone.addEventListener("blur", () => elements.pasteZone.classList.remove("is-active"));
  elements.fileInput.addEventListener("change", (event) => handleImageFile(event.target.files[0]));
  if (elements.recognized) {
    elements.recognized.innerHTML = `<div class="empty-results">data 로딩 중입니다.</div>`;
  }
  loadNikkeData();
})();
