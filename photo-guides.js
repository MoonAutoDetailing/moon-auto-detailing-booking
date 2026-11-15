// Line sketches for the guided before/after photos: what should be in frame for each shot.
// Keys match PHOTO_SHOTS in api/_jobs.js. Drawn in currentColor (white on the crew app's dark
// cards) on a 160×120 canvas — the same 4:3 shape as a phone photo.

const FRAME = `<path d="M4 16V4h12M144 4h12v12M156 104v12h-12M16 116H4v-12" stroke-width="1.5" opacity=".55"/>`;

const svg = (body, { mirror = false } = {}) =>
  `<svg viewBox="0 0 160 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FRAME}${
    mirror ? `<g transform="translate(160 0) scale(-1 1)">${body}</g>` : body
  }</svg>`;

// Front seat seen through an open front door: door panel on the left (front of the car),
// dash, then the seat in profile, center console beyond it and the floor below.
const frontSeat = (wheel) => `
  <path d="M8 14 L26 20 L26 112 L8 116 Z"/>
  <path d="M10 64 L26 61"/><path d="M13 50 L22 49"/>
  <path d="M26 30 Q44 24 66 32 L66 62 L26 66"/>
  ${wheel
    ? `<ellipse cx="50" cy="44" rx="12" ry="18"/><ellipse cx="50" cy="44" rx="4" ry="6"/><path d="M46 44 L38.5 40 M54 44 L61.5 40 M50 50 L50 61"/><path d="M58 56 L66 60"/>`
    : `<rect x="32" y="40" width="28" height="14" rx="2"/><path d="M42 47 h8"/>`}
  <path d="M66 70 L112 67 L114 82 L66 85 Z"/>
  <circle cx="78" cy="75" r="3"/><circle cx="88" cy="74.5" r="3"/>
  <path d="M101 70 V61"/><circle cx="101" cy="58" r="3"/>
  <path d="M62 92 Q60 86 68 86 L116 82 Q124 82 124 90 L122 98 L68 102 Q60 101 62 92 Z"/>
  <path d="M114 84 L122 42 Q124 34 132 34 L138 35 Q145 37 143 46 L132 92"/>
  <rect x="122" y="16" width="20" height="15" rx="5"/><path d="M128 31 V35 M136 31 V35"/>
  <path d="M28 114 L33 96 L62 96 L60 114 Z"/>
  <path d="M38 92 L40 100 M48 92 L50 100"/>
  <path d="M152 8 V116"/>`;

// Back seat seen through an open rear door: back of the front seat on the left, bench seat
// on the right, floor between them.
const rearSeat = (third) => `
  <path d="M8 14 L22 20 L22 112 L8 116 Z"/><path d="M10 64 L22 62"/>
  <path d="M28 96 L30 34 Q31 26 40 26 L52 27 Q58 28 57 36 L54 96"/>
  <rect x="32" y="10" width="20" height="14" rx="5"/><path d="M38 24 V27 M46 24 V27"/>
  <path d="M33 60 L53 60 L52 82 L32 82"/>
  <path d="M60 94 Q58 88 66 88 L140 85 Q148 85 147 93 L146 100 L66 103 Q58 102 60 94 Z"/>
  <path d="M132 86 L136 ${third ? 48 : 40} Q138 ${third ? 42 : 34} 145 ${third ? 42 : 34} L150 ${third ? 43 : 35} Q154 ${third ? 46 : 38} 153 ${third ? 52 : 44} L148 88"/>
  <rect x="${third ? 136 : 134}" y="${third ? 30 : 20}" width="${third ? 16 : 18}" height="${third ? 11 : 13}" rx="4"/>
  <path d="M100 87 L104 ${third ? 52 : 44} M116 86 L118 ${third ? 50 : 42}" opacity=".7"/>
  <path d="M56 114 L60 104 L130 104 L128 114 Z"/>
  ${third ? `<path d="M24 20 L156 18" opacity=".5"/><path d="M60 40 L120 38" stroke-dasharray="3 4" opacity=".5"/>` : `<path d="M24 20 L156 18" opacity=".5"/>`}`;

const SKETCHES = {
  front_driver: svg(frontSeat(true)),
  front_passenger: svg(frontSeat(false), { mirror: true }),
  rear_driver: svg(rearSeat(false)),
  rear_passenger: svg(rearSeat(false), { mirror: true }),
  third_driver: svg(rearSeat(true)),
  third_passenger: svg(rearSeat(true), { mirror: true }),

  // Open hatch from behind: the opening, seatbacks at the far end, cargo floor.
  trunk: svg(`
    <path d="M30 8 L130 8 L142 22 L18 22 Z"/>
    <path d="M18 22 L10 104 L150 104 L142 22"/>
    <path d="M34 34 L126 34 L130 70 L30 70 Z"/>
    <rect x="44" y="26" width="18" height="9" rx="3"/><rect x="98" y="26" width="18" height="9" rx="3"/>
    <path d="M80 34 V70" opacity=".6"/>
    <path d="M30 70 L14 102 M130 70 L146 102"/>
    <path d="M30 70 L130 70"/>
    <path d="M40 86 H120" stroke-dasharray="4 4" opacity=".5"/>
    <path d="M6 40 L12 40 L10 64 L4 64 Z M154 40 L148 40 L150 64 L156 64 Z"/>
    <path d="M8 104 L8 114 L152 114 L152 104"/>`),

  // Front of the car, straight on.
  ext_front: svg(`
    <path d="M50 22 L110 22 L124 50 L36 50 Z"/>
    <path d="M36 50 L18 54 Q14 56 14 62 L14 88 Q14 92 18 92 L142 92 Q146 92 146 88 L146 62 Q146 56 142 54 L124 50"/>
    <path d="M24 60 Q34 58 44 62 L42 68 Q32 68 24 66 Z M136 60 Q126 58 116 62 L118 68 Q128 68 136 66 Z"/>
    <rect x="58" y="62" width="44" height="14" rx="4"/><path d="M62 69 H98" opacity=".6"/>
    <path d="M20 82 H140"/>
    <path d="M22 92 V104 Q22 106 25 106 H37 Q40 106 40 104 V92 M120 92 V104 Q120 106 123 106 H135 Q138 106 138 104 V92"/>
    <path d="M36 46 L28 42 L26 47 Z M124 46 L132 42 L134 47 Z"/>
    <path d="M66 86 H94"/>`),

  // Front three-quarter from the passenger side: front face on the left, side to the right.
  ext_front_right: svg(`
    <path d="M10 62 L50 68 L50 92 L12 86 Z"/>
    <path d="M10 62 L36 50 L80 52 L50 68"/>
    <path d="M36 50 L56 32 L94 31 L80 52"/>
    <path d="M94 31 L128 31 L148 50 L80 52"/>
    <path d="M86 48 L97 34 L111 34 L111 49 Z M115 34 L126 34 L140 49 L115 49 Z"/>
    <path d="M148 50 L152 62 L150 86 L50 92"/>
    <path d="M14 66 L26 68 L26 72 L14 70 Z M40 70 L48 71 L48 75 L40 74 Z"/>
    <path d="M24 76 L42 79 L42 84 L24 81 Z"/>
    <path d="M112 52 L112 86" opacity=".7"/><path d="M84 54 L84 89" opacity=".7"/>
    <ellipse cx="70" cy="91" rx="10" ry="12"/><ellipse cx="70" cy="91" rx="5" ry="6"/>
    <ellipse cx="132" cy="86" rx="9" ry="11"/><ellipse cx="132" cy="86" rx="4.5" ry="5.5"/>
    <path d="M82 52 L78 46 L74 50"/>`),

  // Rear three-quarter from the driver side: back end on the right, side to the left.
  ext_rear_left: svg(`
    <path d="M10 62 L50 68 L50 92 L12 86 Z"/>
    <path d="M10 62 L30 52 L80 52 L50 68"/>
    <path d="M30 52 L50 34 L92 31 L80 52"/>
    <path d="M92 31 L128 31 L150 52 L80 52"/>
    <path d="M86 48 L96 34 L111 34 L111 49 Z M115 34 L126 34 L142 49 L115 49 Z"/>
    <path d="M150 52 L152 62 L150 86 L50 92"/>
    <path d="M12 66 L24 67 L24 74 L12 72 Z M38 69 L48 70 L48 77 L38 76 Z"/>
    <path d="M22 80 L42 83" /><rect x="25" y="70" width="10" height="5" rx="1" transform="rotate(8 30 72)"/>
    <path d="M112 52 L112 86" opacity=".7"/><path d="M84 54 L84 89" opacity=".7"/>
    <ellipse cx="70" cy="91" rx="10" ry="12"/><ellipse cx="70" cy="91" rx="5" ry="6"/>
    <ellipse cx="132" cy="86" rx="9" ry="11"/><ellipse cx="132" cy="86" rx="4.5" ry="5.5"/>`, { mirror: true }),

  // One wheel filling the frame.
  ext_wheel: svg(`
    <circle cx="80" cy="60" r="48"/>
    <circle cx="80" cy="60" r="32"/>
    <circle cx="80" cy="60" r="9"/>
    ${[0, 72, 144, 216, 288].map((a) => {
      const r = (a - 90) * Math.PI / 180;
      const x1 = 80 + Math.cos(r) * 10, y1 = 60 + Math.sin(r) * 10, x2 = 80 + Math.cos(r) * 30, y2 = 60 + Math.sin(r) * 30;
      const lx = 80 + Math.cos(r + 0.63) * 14, ly = 60 + Math.sin(r + 0.63) * 14;
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="1.6"/>`;
    }).join("")}
    <path d="M58 38 A31 31 0 0 1 72 30" stroke-width="5" opacity=".6"/>
    <path d="M30 18 Q80 -6 130 18" opacity=".5"/>`),
};

export function photoGuide(key) {
  return SKETCHES[key] || svg(`<rect x="30" y="24" width="100" height="72" rx="8"/><circle cx="80" cy="60" r="16"/>`);
}
