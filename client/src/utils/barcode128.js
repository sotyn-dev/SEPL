// Code 128 (Subset B) Vector SVG Generator for TVS Barcode Label Printers
// Encodes alphanumeric text (e.g. T-2026-0001, RGP-TL-0042) into sharp vector monochrome bars.

const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", // 0-9
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", // 10-19
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", // 20-29
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", // 30-39
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", // 40-49
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", // 50-59
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", // 60-69
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", // 70-79
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", // 80-89
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", // 90-99
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112" // 100-106 (104=Start B, 106=Stop)
];

export function generateCode128Svg(text, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return '';

  const height = options.height || 36;
  const barWidth = options.barWidth || 1.4;
  const showText = options.showText !== false;
  const fontSize = options.fontSize || 10;

  // Start with Start B (index 104)
  const indices = [104];
  let checksum = 104;

  for (let i = 0; i < cleanText.length; i++) {
    const code = cleanText.charCodeAt(i) - 32;
    if (code < 0 || code > 95) continue;
    indices.push(code);
    checksum += code * (i + 1);
  }

  const checkIndex = checksum % 103;
  indices.push(checkIndex);
  indices.push(106); // Stop pattern

  // Calculate bars
  const bars = [];
  let totalModules = 0;
  for (const idx of indices) {
    const pat = PATTERNS[idx] || "212222";
    for (let j = 0; j < pat.length; j++) {
      const w = parseInt(pat[j], 10);
      const isBar = (j % 2 === 0);
      bars.push({ width: w, isBar });
      totalModules += w;
    }
  }

  const svgWidth = Math.ceil(totalModules * barWidth);
  const svgHeight = height + (showText ? fontSize + 4 : 0);

  let x = 0;
  let rects = '';
  for (const b of bars) {
    const w = b.width * barWidth;
    if (b.isBar) {
      rects += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="#000" />`;
    }
    x += w;
  }

  let textSvg = '';
  if (showText) {
    textSvg = `<text x="${(svgWidth / 2).toFixed(1)}" y="${svgHeight - 2}" font-family="monospace, 'Courier New', sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" fill="#000">${cleanText}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" style="max-width:100%;height:auto;display:block;margin:0 auto;">${rects}${textSvg}</svg>`;
}

