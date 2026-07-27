// Generates the favicon / app-icon set in public/ from the slackfin logo.
// Run with: npm run icons
//
// The source logo is a 2000x2000 PNG with the wave floating in a large field of
// paper. We trim to the artwork first, then re-center it on a square paper
// canvas so each icon controls its own padding. The wave is ~1.89:1, so it is
// always width-constrained inside the square.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "public", "slackfin_logo.png");
const OUT = path.join(root, "public");

// Design tokens (mirrors PALETTE in src/App.jsx)
const PAPER = "#E4F5FB";

// Browser tabs render at 16-32px, so the favicon gets a tight crop for
// legibility. Home-screen icons get 10% so iOS's rounded mask has room.
const TARGETS = [
  { file: "favicon-32.png", size: 32, padding: 0.04 },
  { file: "apple-touch-icon.png", size: 180, padding: 0.1 },
  { file: "icon-192.png", size: 192, padding: 0.1 },
  { file: "icon-512.png", size: 512, padding: 0.1 },
];

/** Trim the surrounding paper so padding is measured against the artwork. */
async function trimmedLogo() {
  const { data, info } = await sharp(SRC)
    .trim({ threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Center the artwork on a square paper canvas at `size`, inset by `padding`. */
async function renderIcon(logo, size, padding) {
  const box = Math.round(size * (1 - padding * 2));
  const scale = Math.min(box / logo.width, box / logo.height);
  const width = Math.max(1, Math.round(logo.width * scale));
  const height = Math.max(1, Math.round(logo.height * scale));

  const artwork = await sharp(logo.data)
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: PAPER,
    },
  })
    .composite([
      {
        input: artwork,
        top: Math.round((size - height) / 2),
        left: Math.round((size - width) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const logo = await trimmedLogo();
  console.log(`source ${path.relative(root, SRC)} -> trimmed ${logo.width}x${logo.height}`);

  await mkdir(OUT, { recursive: true });

  const rendered = new Map();
  for (const { file, size, padding } of TARGETS) {
    const buffer = await renderIcon(logo, size, padding);
    await writeFile(path.join(OUT, file), buffer);
    rendered.set(file, buffer);
    console.log(`  wrote ${file} (${size}x${size}, ${Math.round(padding * 100)}% padding)`);
  }

  // 32x32 .ico fallback, built from the favicon PNG we just rendered.
  const ico = await pngToIco([rendered.get("favicon-32.png")]);
  await writeFile(path.join(OUT, "favicon.ico"), ico);
  console.log("  wrote favicon.ico (32x32)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
