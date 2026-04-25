(function () {
  const DRAFT_KEY = "label-product-current-draft-v1";
  const DRAFT_DB_NAME = "label-draft";
  const DRAFT_STORE_NAME = "blobs";
  const DRAFT_BLOB_KEY = "current";
  const PROMO_PATTERNS = [
    /\bSPECIALS?\b/i,
    /\bSAVE\b/i,
    /\bOFF\b/i,
    /\bWAS\b/i,
    /\bNOW\b/i,
    /\bSALE\b/i,
    /\bPRICE\b/i,
    /\bSINGLE\s+PRICE\b/i,
    /\bEND\s+DATE\b/i,
    /\bBEST\s+BEFORE\b/i,
    /\bEXP(?:IRY|IRES|IRATION)?\b/i,
    /\bHALF\s+PRICE\b/i,
    /\bCLEARANCE\b/i,
    /\bDISCOUNT\b/i,
    /\bMEMBER\b/i,
    /\bEACH\b/i,
    /\bPER\s+\d/i,
    /\$\s*\d/i,
    /\d+\s*%\s*(?:OFF)?/i,
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
  ];

  const UNIT_PATTERN = /\b\d+(?:\.\d+)?\s?(?:G|GM|KG|ML|L|OZ|LB|PCS|PC|PACK|PK|CT|EA)\b/i;
  const BRAND_PATTERN =
    /\b(?:FUJIYA|LOTTE|NONGSHIM|OTTOGI|SAMYANG|PALDO|CJ|HAITAI|ORION|CALBEE|MEIJI|GLICO|MORINAGA|KIKKOMAN|LEE\s*KUM\s*KEE|S&B|YAMASA|AJINOMOTO|SAPPORO|KIRIN|POKKA|ITO\s*EN)\b/i;

  const OCR_FIXES = [
    { pattern: /\bFUJIYAPARET{1,2}I?E?R?E?\b/gi, replace: "FUJIYA PARETTIERE" },
    { pattern: /\bFUJIYA\s*PARET{1,2}I?E?R?E?\b/gi, replace: "FUJIYA PARETTIERE" },
    { pattern: /\bJJIYA\b/gi, replace: "FUJIYA" },
    { pattern: /\bAMANASHI\b/gi, replace: "YAMANASHI" },
    { pattern: /\bPARETTIERE\s+I\s+YAMANASHI\b/gi, replace: "PARETTIERE YAMANASHI" },
    { pattern: /\bGHAN[A4]\b/gi, replace: "GHANA" },
    { pattern: /\b(MUSCAT|PLUMS)\s+80\b/gi, replace: "$1 80G" },
    { pattern: /\b([38])0G[35]\b/gi, replace: "80G" },
    { pattern: /\b([38])06\b/gi, replace: "80G" },
    { pattern: /\b([38])0\s*6\b/gi, replace: "80G" },
    { pattern: /\b30G3\b/gi, replace: "80G" },
  ];

  function applyOcrFixes(text) {
    return OCR_FIXES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replace), text);
  }

  const $ = (selector) => document.querySelector(selector);

  const dom = {
    imageInput: $("#imageInput"),
    dropZone: $("#dropZone"),
    previewFrame: $("#previewFrame"),
    preview: $("#preview"),
    selectionCanvas: $("#selectionCanvas"),
    selectionPanel: $("#selectionPanel"),
    selectionHint: $("#selectionHint"),
    cancelSelectionBtn: $("#cancelSelectionBtn"),
    recognizeSelectionBtn: $("#recognizeSelectionBtn"),
    clearStrokesBtn: $("#clearStrokesBtn"),
    strokeSizeRange: $("#strokeSizeRange"),
    strokeSizeValue: $("#strokeSizeValue"),
    previewActions: $("#previewActions"),
    replaceImageBtn: $("#replaceImageBtn"),
    selectNameBtn: $("#selectNameBtn"),
    removeImageBtn: $("#removeImageBtn"),
    statusPill: $("#statusPill"),
    progressText: $("#progressText"),
    productName: $("#productName"),
    barcode: $("#barcode"),
    productSearchLink: $("#productSearchLink"),
    copyProductBtn: $("#copyProductBtn"),
    copyBarcodeBtn: $("#copyBarcodeBtn"),
    rawText: $("#rawText"),
    suggestionBanner: $("#suggestionBanner"),
    suggestNameBtn: $("#suggestNameBtn"),
    barcodeSearchLink: $("#barcodeSearchLink"),
  };

  const STROKE_RADIUS_KEY = "label-stroke-radius-v1";
  const STROKE_RADIUS_MIN = 6;
  const STROKE_RADIUS_MAX = 30;
  const STROKE_RADIUS_DEFAULT = 12;
  let strokeRadiusCss = readPersistedStrokeRadius();
  let activeFile = null;
  let latestObjectUrl = "";
  let selectionMode = "";
  let selectionStrokes = [];
  let currentStroke = null;
  let zxingDetectorPromise = null;

  function clampStrokeRadius(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return STROKE_RADIUS_DEFAULT;
    return Math.max(STROKE_RADIUS_MIN, Math.min(STROKE_RADIUS_MAX, Math.round(num)));
  }

  function readPersistedStrokeRadius() {
    try {
      const raw = localStorage.getItem(STROKE_RADIUS_KEY);
      if (raw == null) return STROKE_RADIUS_DEFAULT;
      return clampStrokeRadius(raw);
    } catch {
      return STROKE_RADIUS_DEFAULT;
    }
  }

  function persistStrokeRadius(value) {
    try {
      localStorage.setItem(STROKE_RADIUS_KEY, String(value));
    } catch {}
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/[|]/g, "I")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function normalizeLine(line) {
    return line
      .replace(/[|]/g, "I")
      .replace(/[^\p{L}\p{N}.$%/&+\- ']/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanProductLine(line) {
    return applyOcrFixes(normalizeLine(line))
      .replace(/[=~_;:]+/g, " ")
      .replace(/\b(?:I{3,}|I?L{3,})\w*\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function isValidEan13(code) {
    if (!/^\d{13}$/.test(code)) return false;
    const digits = code.split("").map(Number);
    const sum = digits
      .slice(0, 12)
      .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
    const check = (10 - (sum % 10)) % 10;
    return check === digits[12];
  }

  function isValidEan8(code) {
    if (!/^\d{8}$/.test(code)) return false;
    const digits = code.split("").map(Number);
    const sum = digits
      .slice(0, 7)
      .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
    const check = (10 - (sum % 10)) % 10;
    return check === digits[7];
  }

  function isValidUpcA(code) {
    if (!/^\d{12}$/.test(code)) return false;
    const digits = code.split("").map(Number);
    const sum = digits
      .slice(0, 11)
      .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
    const check = (10 - (sum % 10)) % 10;
    return check === digits[11];
  }

  function barcodeStrength(code) {
    if (code.length === 13 && isValidEan13(code)) return 3;
    if (code.length === 12 && isValidUpcA(code)) return 3;
    if (code.length === 8 && isValidEan8(code)) return 3;
    if (code.length === 14) return 2;
    return 0;
  }

  function isLikelyBarcode(code) {
    if (!/^\d+$/.test(code)) return false;
    return barcodeStrength(code) > 0;
  }

  function extractBarcode(text, detectorValue = "") {
    const found = [];
    const detectorDigits = onlyDigits(detectorValue);
    if (isLikelyBarcode(detectorDigits)) found.push(detectorDigits);

    const compactText = normalizeText(text);
    const looseMatches = compactText
      .split("\n")
      .flatMap((line) => line.match(/\d(?:[ \t]?\d){6,15}/g) || []);
    for (const match of looseMatches) {
      const digits = onlyDigits(match);
      if (isLikelyBarcode(digits)) found.push(digits);
    }

    const unique = [...new Set(found)];
    unique.sort((a, b) => barcodeStrength(b) - barcodeStrength(a) || b.length - a.length);
    return unique[0] || "";
  }

  function lineLooksPromotional(line) {
    const clean = normalizeLine(line);
    if (!clean) return true;
    if (PROMO_PATTERNS.some((pattern) => pattern.test(clean))) return true;
    if (/^SPECI?A?LS?$/i.test(clean.replace(/\s/g, ""))) return true;
    if (/^\$?\s*\d+(?:[.,]\d{1,2})?$/.test(clean)) return true;
    if (/^[\d\s.$%/-]+$/.test(clean)) return true;
    if (onlyDigits(clean).length >= 7) return true;
    const letters = clean.match(/\p{L}/gu) || [];
    const digits = clean.match(/\d/g) || [];
    if (digits.length > letters.length * 2 && !UNIT_PATTERN.test(clean)) return true;
    return false;
  }

  function scoreProductLine(line) {
    const clean = cleanProductLine(line);
    const letters = clean.match(/\p{L}/gu) || [];
    const digits = clean.match(/\d/g) || [];
    if (letters.length < 3) return -20;
    let score = letters.length * 2;
    if (UNIT_PATTERN.test(clean)) score += 12;
    if (BRAND_PATTERN.test(clean)) score += 34;
    if (/\b(?:MILK|CHOCOLATE|NOODLE|RICE|TEA|SAUCE|SNACK|BISCUIT|COOKIE|CANDY|DRINK|JUICE|COFFEE|PLUMS?|MUSCAT|GRAPE|APPLE|MANGO|PEACH|RAMEN|CURRY|SEAWEED)\b/i.test(clean)) {
      score += 8;
    }
    if (/^[A-Z0-9 .&'/-]+$/.test(clean)) score += 4;
    const punctuation = clean.match(/[.$%/&+\-']/g) || [];
    if (punctuation.length > 2 && !BRAND_PATTERN.test(clean)) score -= punctuation.length * 4;
    const lowercase = clean.match(/[a-z]/g) || [];
    if (lowercase.length > letters.length * 0.25) score -= 18;
    if (clean.length > 44) score -= Math.round((clean.length - 44) / 2);
    if (digits.length > 0 && !UNIT_PATTERN.test(clean)) score -= digits.length;
    return score;
  }

  function extractProductName(text) {
    const lines = normalizeText(text)
      .split("\n")
      .map(cleanProductLine)
      .filter(Boolean)
      .filter((line) => !lineLooksPromotional(line));

    if (!lines.length) return "";

    const scored = lines.map((line, index) => ({
      line,
      index,
      score: scoreProductLine(line),
    }));

    const brandIndex = scored.findIndex((item) => BRAND_PATTERN.test(item.line));
    if (brandIndex >= 0) {
      const block = [];
      for (let index = brandIndex; index < Math.min(scored.length, brandIndex + 4); index += 1) {
        const item = scored[index];
        if (index !== brandIndex && item.score < 8) break;
        block.push(item.line);
        if (UNIT_PATTERN.test(item.line) && block.length >= 2) break;
      }
      if (block.length) return cleanSearchText(block.join(" "));
    }

    let bestBlock = [];
    let bestScore = -Infinity;
    for (let start = 0; start < scored.length; start += 1) {
      let blockScore = 0;
      const block = [];
      for (let end = start; end < Math.min(scored.length, start + 4); end += 1) {
        if (scored[end].score <= 0) break;
        block.push(scored[end].line);
        blockScore += scored[end].score;
        const joined = block.join(" ");
        if (UNIT_PATTERN.test(joined)) blockScore += 10;
        if (joined.length > 72) blockScore -= joined.length - 72;
        if (blockScore > bestScore) {
          bestScore = blockScore;
          bestBlock = [...block];
        }
      }
    }

    if (!bestBlock.length) {
      bestBlock = scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 2)
        .sort((a, b) => a.index - b.index)
        .map((item) => item.line);
    }

    return cleanSearchText(bestBlock.join(" "));
  }

  function cleanSearchText(value) {
    let text = applyOcrFixes(normalizeLine(value))
      .replace(/\b(?:I{3,}|I?L{3,})\w*\b/gi, " ")
      .replace(/\bSUG\b/gi, " ")
      .replace(/[=~_;:.[\]]+/g, " ")
      .replace(/\bSPECIALS?\b/gi, " ")
      .replace(/\b(?:SAVE|OFF|SINGLE PRICE|END DATE|PRICE|SALE|CLEARANCE)\b/gi, " ")
      .replace(/\$\s*\d+(?:[.,]\d{1,2})?/g, " ")
      .replace(/\d+\s*%\s*(?:OFF)?/gi, " ")
      .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
      .replace(/\s+[-/]+\s*$/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    text = text.replace(/\s+([.,])/g, "$1");
    return text.toUpperCase();
  }

  function buildSearchQuery(productName, barcode) {
    const name = cleanSearchText(productName);
    const code = onlyDigits(barcode);
    return name || code;
  }

  function googleImagesUrl(query) {
    const finalQuery = String(query || "").trim();
    if (!finalQuery) return "";
    return `https://www.google.com/search?udm=2&q=${encodeURIComponent(finalQuery)}`;
  }

  function setSearchLink(link, query) {
    const finalQuery = String(query || "").trim();
    const url = googleImagesUrl(finalQuery);
    link.href = url || "#";
    link.classList.toggle("disabled", !finalQuery);
    link.setAttribute("aria-disabled", finalQuery ? "false" : "true");
  }

  function updateCopyButton(button, value) {
    button.disabled = !String(value || "").trim();
  }

  function productNameNeedsHelp(value) {
    if (!activeFile) return false;
    const name = cleanSearchText(value);
    if (!name) return true;

    const letters = name.match(/\p{L}/gu) || [];
    const words = name.split(/\s+/).filter(Boolean);
    if (letters.length < 10) return true;
    if (BRAND_PATTERN.test(name) && words.length <= 2 && !UNIT_PATTERN.test(name)) return true;
    if (words.length <= 2 && !UNIT_PATTERN.test(name)) return true;
    return false;
  }

  function updateSuggestionBanner() {
    if (!dom.suggestionBanner) return;
    dom.suggestionBanner.hidden = !productNameNeedsHelp(dom.productName.value);
  }

  async function copyValue(value, button) {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    const oldText = button.textContent;
    button.textContent = "已复制";
    window.setTimeout(() => {
      button.textContent = oldText;
    }, 1200);
  }

  function parseLabelText(text, detectorBarcode = "") {
    const barcode = extractBarcode(text, detectorBarcode);
    const productName = extractProductName(text);
    return {
      productName,
      barcode,
      searchQuery: buildSearchQuery(productName, barcode),
      rawText: normalizeText(text),
    };
  }

  function scoreParsedResult(parsed) {
    const name = parsed.productName || "";
    const letters = name.match(/\p{L}/gu) || [];
    let score = letters.length * 2;
    if (parsed.barcode) score += 80;
    if (UNIT_PATTERN.test(name)) score += 18;
    if (BRAND_PATTERN.test(name)) score += 16;
    if (name.length > 80) score -= name.length - 80;
    if (!name) score -= 30;
    return score;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("图片处理失败"));
      }, "image/png");
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("图片无法读取"));
      };
      img.src = url;
    });
  }

  async function makeDraftBlob(file) {
    const img = await loadImage(file);
    const maxSide = 1100;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("草稿图片处理失败"))),
        "image/jpeg",
        0.72,
      );
    });
  }

  function openDraftDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB 不可用"));
        return;
      }
      const request = indexedDB.open(DRAFT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          request.result.createObjectStore(DRAFT_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function setDraftBlob(blob) {
    try {
      const db = await openDraftDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE_NAME, "readwrite");
        tx.objectStore(DRAFT_STORE_NAME).put(blob, DRAFT_BLOB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function getDraftBlob() {
    try {
      const db = await openDraftDb();
      const blob = await new Promise((resolve) => {
        const tx = db.transaction(DRAFT_STORE_NAME, "readonly");
        const request = tx.objectStore(DRAFT_STORE_NAME).get(DRAFT_BLOB_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
      db.close();
      return blob;
    } catch {
      return null;
    }
  }

  async function deleteDraftBlob() {
    try {
      const db = await openDraftDb();
      await new Promise((resolve) => {
        const tx = db.transaction(DRAFT_STORE_NAME, "readwrite");
        tx.objectStore(DRAFT_STORE_NAME).delete(DRAFT_BLOB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      db.close();
    } catch {}
  }

  function persistDraft() {
    const draft = {
      productName: dom.productName.value,
      barcode: dom.barcode.value,
      rawText: dom.rawText.textContent,
      hasImage: Boolean(activeFile),
    };

    if (!draft.productName && !draft.barcode && !draft.hasImage) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {}
  }

  async function restoreDraft() {
    let draft;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch {
      return;
    }
    if (!draft) return;

    dom.productName.value = draft.productName || "";
    dom.barcode.value = draft.barcode || "";
    dom.rawText.textContent = draft.rawText || "";

    if (draft.hasImage) {
      const blob = await getDraftBlob();
      if (blob) {
        activeFile = blob;
        if (latestObjectUrl) URL.revokeObjectURL(latestObjectUrl);
        latestObjectUrl = URL.createObjectURL(blob);
        dom.preview.src = latestObjectUrl;
        dom.previewFrame.hidden = false;
        dom.previewActions.hidden = false;
        dom.preview.onload = resizeSelectionCanvas;
        if (dom.preview.complete) resizeSelectionCanvas();
      }
    }

    if (draft.productName || draft.barcode) {
      setStatus("ready", "已恢复", "保留了上次识别结果");
    }
  }

  function isYellowPixel(r, g, b) {
    return r > 105 && g > 70 && b < 155 && r > b * 1.2 && g > b * 1.08 && r + g > 210;
  }

  function isWhitePixel(r, g, b) {
    if (r < 215 || g < 215 || b < 210) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max - min < 28;
  }

  function findLabelBounds(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const step = 6;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        if (isYellowPixel(r, g, b) || isWhitePixel(r, g, b)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          count += 1;
        }
      }
    }

    const sampleCount = Math.ceil(width / step) * Math.ceil(height / step);
    if (count < sampleCount * 0.012) return { x: 0, y: 0, width, height };

    const pad = Math.round(Math.max(width, height) * 0.025);
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const right = Math.min(width, maxX + pad);
    const bottom = Math.min(height, maxY + pad);
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
    };
  }

  function otsuThreshold(grayValues) {
    const histogram = new Array(256).fill(0);
    for (const value of grayValues) histogram[value] += 1;

    const total = grayValues.length;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

    let sumB = 0;
    let weightB = 0;
    let maxVariance = 0;
    let threshold = 145;

    for (let i = 0; i < 256; i += 1) {
      weightB += histogram[i];
      if (weightB === 0) continue;
      const weightF = total - weightB;
      if (weightF === 0) break;
      sumB += i * histogram[i];
      const meanB = sumB / weightB;
      const meanF = (sum - sumB) / weightF;
      const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
      if (variance > maxVariance) {
        maxVariance = variance;
        threshold = i;
      }
    }

    return Math.max(95, Math.min(175, threshold + 8));
  }

  function enhanceForOcr(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const grayValues = [];
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = Math.round(image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114);
      grayValues.push(gray);
    }

    const threshold = otsuThreshold(grayValues);
    for (let i = 0, j = 0; i < image.data.length; i += 4, j += 1) {
      const gray = grayValues[j];
      const value = gray < threshold ? 0 : 255;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function resizeSelectionCanvas() {
    if (dom.previewFrame.hidden) return;
    const rect = dom.previewFrame.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    dom.selectionCanvas.width = Math.max(1, Math.round(rect.width * ratio));
    dom.selectionCanvas.height = Math.max(1, Math.round(rect.height * ratio));
    dom.selectionCanvas.style.width = `${rect.width}px`;
    dom.selectionCanvas.style.height = `${rect.height}px`;
    drawSelection();
  }

  function drawSelection() {
    const canvas = dom.selectionCanvas;
    const ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!selectionMode) return;

    const strokes = currentStroke ? [...selectionStrokes, currentStroke] : selectionStrokes;
    if (!strokes.length) return;

    ctx.lineWidth = strokeRadiusCss * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(33, 122, 89, 0.32)";

    for (const stroke of strokes) {
      if (!stroke.length) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let index = 1; index < stroke.length; index += 1) {
        ctx.lineTo(stroke[index].x, stroke[index].y);
      }
      if (stroke.length === 1) {
        ctx.arc(stroke[0].x, stroke[0].y, strokeRadiusCss, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(33, 122, 89, 0.32)";
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
  }

  function pointFromEvent(event) {
    const bounds = dom.selectionCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  }

  function totalStrokePoints() {
    let total = currentStroke ? currentStroke.length : 0;
    for (const stroke of selectionStrokes) total += stroke.length;
    return total;
  }

  function hasUsableStroke() {
    if (totalStrokePoints() < 4) return false;
    const all = currentStroke ? [...selectionStrokes, currentStroke] : selectionStrokes;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of all) {
      for (const point of stroke) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }
    return maxX - minX >= 18 || maxY - minY >= 14;
  }

  function syncSelectionButtons() {
    const hasStrokes = selectionStrokes.length > 0 || Boolean(currentStroke);
    dom.clearStrokesBtn.disabled = !hasStrokes;
    dom.recognizeSelectionBtn.disabled = !hasUsableStroke();
  }

  function clearStrokes() {
    selectionStrokes = [];
    currentStroke = null;
    syncSelectionButtons();
    drawSelection();
  }

  function startSelection(mode) {
    if (!activeFile) return;
    selectionMode = mode;
    selectionStrokes = [];
    currentStroke = null;
    dom.selectionPanel.hidden = false;
    dom.selectionCanvas.classList.add("active");
    syncSelectionButtons();
    dom.selectionHint.textContent =
      mode === "barcode"
        ? "用手指涂抹覆盖条形码下方的数字"
        : "用手指涂抹覆盖完整商品名和规格";
    resizeSelectionCanvas();
    setStatus("working", "等待涂抹", mode === "barcode" ? "涂抹条形码数字" : "涂抹商品名和规格");
  }

  function stopSelection() {
    selectionMode = "";
    selectionStrokes = [];
    currentStroke = null;
    dom.selectionPanel.hidden = true;
    dom.selectionCanvas.classList.remove("active");
    dom.clearStrokesBtn.disabled = true;
    dom.recognizeSelectionBtn.disabled = true;
    drawSelection();
    if (activeFile) setStatus("ready", "已识别", "可以继续涂抹局部修正");
  }

  function imageContentBox() {
    const frame = dom.previewFrame.getBoundingClientRect();
    const naturalRatio = dom.preview.naturalWidth / dom.preview.naturalHeight;
    const frameRatio = frame.width / frame.height;
    let width = frame.width;
    let height = frame.height;
    let left = 0;
    let top = 0;

    if (frameRatio > naturalRatio) {
      width = frame.height * naturalRatio;
      left = (frame.width - width) / 2;
    } else {
      height = frame.width / naturalRatio;
      top = (frame.height - height) / 2;
    }

    return { left, top, width, height };
  }

  function selectionToNaturalStrokes() {
    if (!selectionStrokes.length || !dom.preview.naturalWidth || !dom.preview.naturalHeight) return null;
    const box = imageContentBox();
    if (box.width < 1 || box.height < 1) return null;

    const scaleX = dom.preview.naturalWidth / box.width;
    const scaleY = dom.preview.naturalHeight / box.height;
    const naturalRadius = strokeRadiusCss * Math.max(scaleX, scaleY);

    const naturalStrokes = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const stroke of selectionStrokes) {
      const points = [];
      for (const point of stroke) {
        const cx = point.x - box.left;
        const cy = point.y - box.top;
        if (cx < 0 || cy < 0 || cx > box.width || cy > box.height) continue;
        const nx = cx * scaleX;
        const ny = cy * scaleY;
        points.push({ x: nx, y: ny });
        if (nx < minX) minX = nx;
        if (ny < minY) minY = ny;
        if (nx > maxX) maxX = nx;
        if (ny > maxY) maxY = ny;
      }
      if (points.length) naturalStrokes.push(points);
    }

    if (!naturalStrokes.length) return null;

    const pad = naturalRadius * 1.1;
    const bboxX = Math.max(0, Math.floor(minX - pad));
    const bboxY = Math.max(0, Math.floor(minY - pad));
    const bboxRight = Math.min(dom.preview.naturalWidth, Math.ceil(maxX + pad));
    const bboxBottom = Math.min(dom.preview.naturalHeight, Math.ceil(maxY + pad));
    const bboxWidth = Math.max(1, bboxRight - bboxX);
    const bboxHeight = Math.max(1, bboxBottom - bboxY);

    if (bboxWidth < 24 || bboxHeight < 18) return null;

    return {
      strokes: naturalStrokes,
      bbox: { x: bboxX, y: bboxY, width: bboxWidth, height: bboxHeight },
      radius: naturalRadius,
    };
  }

  async function cropSelectionForOcr() {
    const data = selectionToNaturalStrokes();
    if (!data) throw new Error("涂抹区域太小，请重新涂抹覆盖文字");
    const { strokes, bbox, radius } = data;

    const img = await loadImage(activeFile);
    const scale = Math.min(3, Math.max(1, 1400 / Math.max(bbox.width, bbox.height)));
    const cropped = document.createElement("canvas");
    cropped.width = Math.max(1, Math.round(bbox.width * scale));
    cropped.height = Math.max(1, Math.round(bbox.height * scale));
    const cctx = cropped.getContext("2d");
    cctx.drawImage(img, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, cropped.width, cropped.height);

    const mask = document.createElement("canvas");
    mask.width = cropped.width;
    mask.height = cropped.height;
    const mctx = mask.getContext("2d");
    mctx.lineWidth = radius * 2 * scale;
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.strokeStyle = "#fff";
    mctx.fillStyle = "#fff";
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      mctx.beginPath();
      mctx.moveTo((stroke[0].x - bbox.x) * scale, (stroke[0].y - bbox.y) * scale);
      for (let index = 1; index < stroke.length; index += 1) {
        mctx.lineTo((stroke[index].x - bbox.x) * scale, (stroke[index].y - bbox.y) * scale);
      }
      if (stroke.length === 1) {
        mctx.beginPath();
        mctx.arc(
          (stroke[0].x - bbox.x) * scale,
          (stroke[0].y - bbox.y) * scale,
          radius * scale,
          0,
          Math.PI * 2,
        );
        mctx.fill();
      } else {
        mctx.stroke();
      }
    }

    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(mask, 0, 0);
    cctx.globalCompositeOperation = "source-over";

    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = cropped.width;
    finalCanvas.height = cropped.height;
    const fctx = finalCanvas.getContext("2d");
    fctx.fillStyle = "#fff";
    fctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    fctx.drawImage(cropped, 0, 0);

    enhanceForOcr(finalCanvas);
    return canvasToBlob(finalCanvas);
  }

  async function recognizeSelection() {
    if (!selectionMode || !activeFile) return;
    try {
      const mode = selectionMode;
      setStatus("working", "正在识别选区", mode === "barcode" ? "读取条形码数字" : "读取商品名");
      const image = await cropSelectionForOcr();
      const text = await recognizeText(image, "选区 · ");
      const parsed = parseLabelText(text);

      if (mode === "barcode") {
        const detectedCode = await detectBarcodeFromImage(image);
        const code = detectedCode || parsed.barcode || extractBarcode(text);
        if (code) {
          dom.barcode.value = code;
        } else {
          throw new Error("没有读到完整条形码数字，请把条码和下方数字一起框住");
        }
      } else {
        const name = parsed.productName || cleanSearchText(text);
        dom.productName.value = name;
      }

      dom.rawText.textContent = normalizeText(text) || "选区没有识别到文字";
      updateActionState();
      stopSelection();
      setStatus("ready", "选区已识别", "可以搜索或继续修改");
    } catch (error) {
      setStatus("error", "选区识别失败", error.message || "请重新涂抹覆盖更清晰的区域");
    }
  }

  function prepareLabelCanvas(img) {
    const maxSide = 1800;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const source = document.createElement("canvas");
    source.width = Math.max(1, Math.round(img.naturalWidth * scale));
    source.height = Math.max(1, Math.round(img.naturalHeight * scale));
    source.getContext("2d").drawImage(img, 0, 0, source.width, source.height);

    const crop = findLabelBounds(source);
    const cropped = document.createElement("canvas");
    cropped.width = crop.width;
    cropped.height = crop.height;
    cropped.getContext("2d").drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return cropped;
  }

  async function rotateAndEnhanceForOcr(croppedCanvas, rotation) {
    const normalizedRotation = ((rotation % 360) + 360) % 360;
    const rotated = document.createElement("canvas");
    if (normalizedRotation === 90 || normalizedRotation === 270) {
      rotated.width = croppedCanvas.height;
      rotated.height = croppedCanvas.width;
    } else {
      rotated.width = croppedCanvas.width;
      rotated.height = croppedCanvas.height;
    }

    const rotatedCtx = rotated.getContext("2d");
    rotatedCtx.fillStyle = "#fff";
    rotatedCtx.fillRect(0, 0, rotated.width, rotated.height);
    rotatedCtx.translate(rotated.width / 2, rotated.height / 2);
    rotatedCtx.rotate((normalizedRotation * Math.PI) / 180);
    rotatedCtx.drawImage(croppedCanvas, -croppedCanvas.width / 2, -croppedCanvas.height / 2);

    enhanceForOcr(rotated);
    const blob = await canvasToBlob(rotated);
    blob.rotation = normalizedRotation;
    return blob;
  }

  function setStatus(type, label, progress = "") {
    dom.statusPill.className = `status-pill ${type}`;
    dom.statusPill.textContent = label;
    dom.progressText.textContent = progress;
  }

  function updateActionState() {
    const productName = cleanSearchText(dom.productName.value);
    const barcode = onlyDigits(dom.barcode.value);

    setSearchLink(dom.productSearchLink, productName);
    setSearchLink(dom.barcodeSearchLink, barcode);
    updateCopyButton(dom.copyProductBtn, productName);
    updateCopyButton(dom.copyBarcodeBtn, barcode);
    updateSuggestionBanner();
    persistDraft();
  }

  function refreshSearchQuery() {
    updateActionState();
  }

  async function detectBarcodeWithNativeApi(file) {
    if (!("BarcodeDetector" in window)) return "";
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      const requested = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"].filter((format) =>
        formats.includes(format),
      );
      if (!requested.length) return "";
      const detector = new window.BarcodeDetector({ formats: requested });
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      bitmap.close?.();
      const detected = results.find((result) => isLikelyBarcode(onlyDigits(result.rawValue)));
      return detected ? detected.rawValue : "";
    } catch {
      return "";
    }
  }

  function loadZxingDetector() {
    if (!zxingDetectorPromise) {
      zxingDetectorPromise = import("https://cdn.jsdelivr.net/npm/barcode-detector@3.1.2/dist/es/ponyfill.js")
        .then((module) => module.BarcodeDetector)
        .catch(() => null);
    }
    return zxingDetectorPromise;
  }

  async function detectBarcodeWithZxing(file) {
    try {
      const Detector = await loadZxingDetector();
      if (!Detector) return "";
      const detector = new Detector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
      });
      const results = await detector.detect(file);
      const result = results.find((item) => isLikelyBarcode(onlyDigits(item.rawValue)));
      const code = onlyDigits(result?.text || "");
      const rawCode = onlyDigits(result?.rawValue || "");
      if (isLikelyBarcode(rawCode)) return rawCode;
      return isLikelyBarcode(code) ? code : "";
    } catch {
      return "";
    }
  }

  async function detectBarcodeFromImage(file) {
    return (await detectBarcodeWithNativeApi(file)) || (await detectBarcodeWithZxing(file));
  }

  async function recognizeText(image, label = "") {
    if (!window.Tesseract) {
      throw new Error("OCR 组件还没有加载完成，请稍后再试。");
    }
    const result = await window.Tesseract.recognize(image, "eng", {
      tessedit_pageseg_mode: window.Tesseract.PSM?.SPARSE_TEXT || "11",
      preserve_interword_spaces: "1",
      logger(event) {
        if (event.status === "recognizing text" && typeof event.progress === "number") {
          const percent = Math.round(event.progress * 100);
          setStatus("working", "正在识别", `${label}${percent}%`);
        }
      },
    });
    return result.data.text || "";
  }

  async function recognizeBest(file) {
    const detectorBarcode = await detectBarcodeFromImage(file);
    const img = await loadImage(file);
    const labelCanvas = prepareLabelCanvas(img);
    const rotations = detectorBarcode ? [0, 90] : [0, 90, 270, 180];
    const attempts = [];

    for (let index = 0; index < rotations.length; index += 1) {
      const rotation = rotations[index];
      setStatus("working", "正在优化图片", `方向 ${index + 1}/${rotations.length}`);
      const image = await rotateAndEnhanceForOcr(labelCanvas, rotation);
      const text = await recognizeText(image, `方向 ${index + 1}/${rotations.length} · `);
      const parsed = parseLabelText(text, detectorBarcode);
      const score = scoreParsedResult(parsed);
      attempts.push({ rotation, text, parsed, score });

      if (parsed.barcode && parsed.productName && score >= 125) break;
    }

    attempts.sort((a, b) => b.score - a.score);
    const best = attempts[0] || { parsed: parseLabelText("", detectorBarcode), text: "", rotation: 0, score: 0 };
    return {
      ...best.parsed,
      rawText: best.text ? normalizeText(best.text) : "",
      rotation: best.rotation,
      attempts,
    };
  }

  async function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    activeFile = file;

    if (latestObjectUrl) URL.revokeObjectURL(latestObjectUrl);
    latestObjectUrl = URL.createObjectURL(file);
    makeDraftBlob(file)
      .then(async (blob) => {
        if (activeFile === file) {
          await setDraftBlob(blob);
          persistDraft();
        }
      })
      .catch(() => {});
    dom.preview.src = latestObjectUrl;
    dom.previewFrame.hidden = false;
    dom.previewActions.hidden = false;
    dom.rawText.textContent = "";
    dom.preview.onload = resizeSelectionCanvas;
    if (dom.preview.complete) resizeSelectionCanvas();
    setStatus("working", "正在处理", "准备识别图片");
    updateActionState();

    try {
      const parsed = await recognizeBest(file);

      dom.productName.value = parsed.productName;
      dom.barcode.value = parsed.barcode;
      dom.rawText.textContent = parsed.rawText || "没有识别到文字";

      if (parsed.productName || parsed.barcode) {
        setStatus("ready", "已识别", "可以分别搜索商品名或条形码");
      } else {
        setStatus("error", "需要修改", "没有提取到可用商品名或条形码");
      }
    } catch (error) {
      setStatus("error", "识别失败", error.message || "请换一张更清晰的图片再试");
    } finally {
      updateActionState();
    }
  }

  function clearCurrentImage() {
    activeFile = null;
    dom.imageInput.value = "";
    if (latestObjectUrl) {
      URL.revokeObjectURL(latestObjectUrl);
      latestObjectUrl = "";
    }
    dom.preview.removeAttribute("src");
    dom.previewFrame.hidden = true;
    dom.previewActions.hidden = true;
    stopSelection();
    dom.productName.value = "";
    dom.barcode.value = "";
    dom.rawText.textContent = "";
    localStorage.removeItem(DRAFT_KEY);
    deleteDraftBlob();
    setStatus("idle", "等待图片", "");
    updateActionState();
  }

  function bindEvents() {
    dom.imageInput.addEventListener("change", (event) => {
      handleFile(event.target.files?.[0]);
    });

    dom.imageInput.addEventListener("click", () => {
      dom.imageInput.value = "";
    });

    dom.replaceImageBtn.addEventListener("click", () => {
      dom.imageInput.value = "";
      dom.imageInput.click();
    });

    dom.cancelSelectionBtn.addEventListener("click", stopSelection);
    dom.selectNameBtn.addEventListener("click", () => startSelection("product"));
    dom.recognizeSelectionBtn.addEventListener("click", recognizeSelection);
    dom.clearStrokesBtn.addEventListener("click", clearStrokes);

    dom.strokeSizeRange.min = String(STROKE_RADIUS_MIN);
    dom.strokeSizeRange.max = String(STROKE_RADIUS_MAX);
    dom.strokeSizeRange.value = String(strokeRadiusCss);
    dom.strokeSizeValue.textContent = String(strokeRadiusCss);
    dom.strokeSizeRange.addEventListener("input", (event) => {
      strokeRadiusCss = clampStrokeRadius(event.target.value);
      dom.strokeSizeValue.textContent = String(strokeRadiusCss);
      persistStrokeRadius(strokeRadiusCss);
      drawSelection();
    });

    function endStroke() {
      if (!currentStroke) return;
      if (currentStroke.length) selectionStrokes.push(currentStroke);
      currentStroke = null;
      syncSelectionButtons();
      drawSelection();
    }

    dom.selectionCanvas.addEventListener("pointerdown", (event) => {
      if (!selectionMode) return;
      event.preventDefault();
      dom.selectionCanvas.setPointerCapture(event.pointerId);
      currentStroke = [pointFromEvent(event)];
      syncSelectionButtons();
      drawSelection();
    });

    dom.selectionCanvas.addEventListener("pointermove", (event) => {
      if (!selectionMode || !currentStroke) return;
      event.preventDefault();
      const point = pointFromEvent(event);
      const last = currentStroke[currentStroke.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 2) {
        currentStroke.push(point);
        syncSelectionButtons();
        drawSelection();
      }
    });

    dom.selectionCanvas.addEventListener("pointerup", (event) => {
      if (!selectionMode || !currentStroke) return;
      event.preventDefault();
      endStroke();
    });

    dom.selectionCanvas.addEventListener("pointercancel", () => {
      if (!selectionMode || !currentStroke) return;
      endStroke();
    });

    dom.removeImageBtn.addEventListener("click", clearCurrentImage);

    window.addEventListener("resize", resizeSelectionCanvas);

    dom.dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dom.dropZone.classList.add("dragging");
    });

    dom.dropZone.addEventListener("dragleave", () => {
      dom.dropZone.classList.remove("dragging");
    });

    dom.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dom.dropZone.classList.remove("dragging");
      handleFile(event.dataTransfer.files?.[0]);
    });

    dom.productName.addEventListener("input", refreshSearchQuery);
    dom.barcode.addEventListener("input", refreshSearchQuery);
    dom.copyProductBtn.addEventListener("click", () => copyValue(dom.productName.value, dom.copyProductBtn));
    dom.copyBarcodeBtn.addEventListener("click", () => copyValue(onlyDigits(dom.barcode.value), dom.copyBarcodeBtn));
    dom.productSearchLink.addEventListener("click", persistDraft);
    dom.barcodeSearchLink.addEventListener("click", persistDraft);
    dom.suggestNameBtn.addEventListener("click", () => startSelection("product"));
  }

  window.LabelRecognizer = {
    parseLabelText,
    cleanSearchText,
    extractBarcode,
    extractProductName,
    buildSearchQuery,
    scoreParsedResult,
  };

  bindEvents();
  restoreDraft();
  updateActionState();

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
