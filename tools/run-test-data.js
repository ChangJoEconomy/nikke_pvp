const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATASET_DIR = path.join(ROOT, "test_data_set");
const ANSWER_PATH = path.join(DATASET_DIR, "answer.txt");
const APP_PATH = path.join(ROOT, "app.js");
const CHARACTERS_PATH = path.join(ROOT, "characters.js");
const MAX_PROCESS_WIDTH = 1400;

function main() {
  const expected = parseAnswers(fs.readFileSync(ANSWER_PATH, "utf8"));
  const matcher = loadMatcher();
  const files = fs.readdirSync(DATASET_DIR)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  let total = 0;
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  const rows = [];

  for (const file of files) {
    const id = path.parse(file).name;
    const image = decodeImage(path.join(DATASET_DIR, file));
    const result = analyzeImage(matcher, image);
    const answers = expected.get(id) || [];

    result.slots.forEach((slot, index) => {
      const answer = answers[index];
      if (!answer) return;
      const candidates = slot.matches.map((match) => match.entry);
      const top = candidates[0];
      const rank = candidates.findIndex((entry) => sameCharacter(entry, answer)) + 1;
      total += 1;
      if (rank === 1) top1 += 1;
      if (rank > 0 && rank <= 3) top3 += 1;
      if (rank > 0 && rank <= 5) top5 += 1;
      rows.push({
        id,
        slot: index + 1,
        expected: formatEntry(answer),
        predicted: top ? formatEntry(top) : "-",
        score: slot.matches[0]?.score || 0,
        rank,
        fallback: slot.card.fallback,
        candidates: slot.matches.map((match) => `${formatEntry(match.entry)} ${match.score.toFixed(3)}`)
      });
    });
  }

  printSummary(total, top1, top3, top5, rows);
  if (top1 !== total) process.exitCode = 1;
}

function parseAnswers(text) {
  const map = new Map();
  let current = null;
  text.split(/\r?\n/).forEach((line) => {
    const section = line.match(/^\[(.+)]$/);
    if (section) {
      current = section[1].trim();
      map.set(current, []);
      return;
    }
    const answer = line.match(/^\d+-\d+:\s*(.+?)\s*\/\s*(.+?)\s*$/);
    if (answer && current) {
      map.get(current).push({ character: answer[1].trim(), skin: normalizeSkin(answer[2]) });
    }
  });
  return map;
}

function loadMatcher() {
  const context = {
    console,
    window: {},
    document: {
      getElementById: (id) => ({
        id,
        style: {},
        classList: { add() {}, remove() {} },
        addEventListener() {},
        getContext: () => ({
          clearRect() {},
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(), width: 0, height: 0 })
        }),
        innerHTML: "",
        textContent: "",
        value: "0.65"
      })
    },
    requestAnimationFrame: (callback) => callback()
  };
  context.globalThis = context;

  const charactersCode = fs.readFileSync(CHARACTERS_PATH, "utf8");
  vm.runInNewContext(charactersCode, context, { filename: CHARACTERS_PATH });

  const appCode = fs.readFileSync(APP_PATH, "utf8").replace(
    /\}\)\(\);\s*$/,
    "globalThis.__nikkeTestExports = { detectCards, describeCard, findMatches };\n})();"
  );
  vm.runInNewContext(appCode, context, { filename: APP_PATH });
  return context.__nikkeTestExports;
}

function analyzeImage(matcher, image) {
  const scale = Math.min(1, MAX_PROCESS_WIDTH / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = scale === 1 ? image.data : resizeNearest(image.data, image.width, image.height, width, height);
  const imageData = { data, width, height };
  const cards = matcher.detectCards(imageData, width, height);
  const slots = cards.map((card, index) => ({
    index,
    card,
    matches: matcher.findMatches(matcher.describeCard(imageData, width, height, card))
  }));
  return { width, height, cards, slots };
}

function decodeImage(file) {
  const size = getImageSize(file);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    maxBuffer: Math.max(16 * 1024 * 1024, size.width * size.height * 4 + 1024)
  });
  return { width: size.width, height: size.height, data: new Uint8ClampedArray(raw) };
}

function getImageSize(file) {
  const b = fs.readFileSync(file);
  if (b.length >= 24 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    let off = 12;
    while (off + 8 <= b.length) {
      const type = b.toString("ascii", off, off + 4);
      const len = b.readUInt32LE(off + 4);
      const data = off + 8;
      if (type === "VP8X") return { width: 1 + b.readUIntLE(data + 4, 3), height: 1 + b.readUIntLE(data + 7, 3) };
      if (type === "VP8 ") return { width: b.readUInt16LE(data + 6) & 0x3fff, height: b.readUInt16LE(data + 8) & 0x3fff };
      if (type === "VP8L") {
        return {
          width: 1 + (((b[data + 2] & 0x3f) << 8) | b[data + 1]),
          height: 1 + (((b[data + 4] & 0x0f) << 10) | (b[data + 3] << 2) | ((b[data + 2] & 0xc0) >> 6))
        };
      }
      off = data + len + (len % 2);
    }
  }
  if (b.length >= 24 && b.readUInt32BE(12) === 0x49484452) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], {
    encoding: "utf8"
  }).trim();
  const [width, height] = probe.split("x").map(Number);
  return { width, height };
}

function resizeNearest(data, srcW, srcH, dstW, dstH) {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y / dstH) * srcH));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x / dstW) * srcW));
      const src = (sy * srcW + sx) * 4;
      const dst = (y * dstW + x) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return out;
}

function sameCharacter(entry, answer) {
  return normalizeName(entry.character) === normalizeName(answer.character) &&
    normalizeSkin(entry.skin) === normalizeSkin(answer.skin);
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSkin(value) {
  return String(value || "default").trim().replace(/_/g, " ").toLowerCase().replace(/\s+/g, " ");
}

function formatEntry(entry) {
  return `${entry.character} / ${entry.skin || "default"}`;
}

function printSummary(total, top1, top3, top5, rows) {
  console.log(`total: ${total}`);
  console.log(`top1: ${top1}/${total} (${percent(top1, total)})`);
  console.log(`top3: ${top3}/${total} (${percent(top3, total)})`);
  console.log(`top5: ${top5}/${total} (${percent(top5, total)})`);
  console.log("");
  rows.forEach((row) => {
    const mark = row.rank === 1 ? "OK" : row.rank > 0 ? `TOP${row.rank}` : "MISS";
    console.log(`${mark} ${row.id}-${row.slot} expected=${row.expected} predicted=${row.predicted} score=${row.score.toFixed(3)}${row.fallback ? " fallback" : ""}`);
    if (row.rank !== 1) console.log(`  candidates: ${row.candidates.join(" | ")}`);
  });
}

function percent(value, total) {
  return total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

main();
