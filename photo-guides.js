// Line sketches for the guided before/after photos: what should be in frame for each shot.
// Keys match PHOTO_SHOTS in api/_jobs.js. Drawn in currentColor (white on the crew app's dark
// cards) on a 160×120 canvas — a phone photo held sideways.
//
// Interiors are one-point perspective through the open door: the door opening frames the
// shot, the near seat is seen side-on and everything across the car shrinks toward the
// vanishing point. Exteriors are straight-on or two-point ¾ views at standing eye height.

const W = 2;      // main outlines
const D = 1.4;    // details
const F = 1;      // faint guides

const FRAME = `<path d="M3 14V3h11M146 3h11v11M157 106v11h-11M14 117H3v-11" stroke-width="1.4" opacity=".5"/>`;

const svg = (body, { mirror = false } = {}) =>
  `<svg viewBox="0 0 160 120" fill="none" stroke="currentColor" stroke-width="${W}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FRAME}${
    mirror ? `<g transform="translate(160 0) scale(-1 1)">${body}</g>` : body
  }</svg>`;

const r1 = (n) => Math.round(n * 10) / 10;
const pathOf = (pts, close = false) => "M" + pts.map(([x, y]) => `${r1(x)} ${r1(y)}`).join(" L") + (close ? " Z" : "");
const line = (pts, w = W, extra = "") => `<path d="${pathOf(pts)}" stroke-width="${w}" ${extra}/>`;
const poly = (pts, w = W, extra = "") => `<path d="${pathOf(pts, true)}" stroke-width="${w}" ${extra}/>`;

// One-point perspective: s = 1 at the near (door) side, smaller across the car.
const toward = (vp) => ([x, y], s) => [vp[0] + (x - vp[0]) * s, vp[1] + (y - vp[1]) * s];

/* ------------------------------------------------------------------ interiors */

// The open doorway every interior shot is taken through: roof rail, sill, the pillars and
// the opened door swung toward the camera on the hinge side (left = front of the car).
const doorway = () => `
  ${line([[14, 7], [150, 7]], D, 'opacity=".7"')}
  ${line([[12, 104], [152, 104]], W)}${line([[10, 112], [154, 112]], D, 'opacity=".6"')}
  ${line([[150, 7], [150, 104]], W)}
  ${poly([[2, 6], [12, 12], [12, 108], [2, 116]], W)}${line([[3, 62], [11, 60]], D)}${line([[4, 80], [11, 79]], D, 'opacity=".7"')}${line([[5, 47], [10, 46]], D)}`;

// Scales an absolute-coordinate path (M/L/C/Q/Z, numbers in x,y pairs) toward the vanishing
// point, so a side profile drawn at the door can be repeated across the car.
function scalePath(d, vp, s) {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => {
    const axis = i++ % 2;
    return String(r1(vp[axis] + (Number(n) - vp[axis]) * s));
  });
}
// A shape seen side-on at the door (near) and again across the car (far), joined at its
// key corners: the basic one-point-perspective "extrusion".
function extrude(d, vp, near, far, joins, { w = W, farOpacity = 0.8, fill = false } = {}) {
  const p = toward(vp);
  return `<path d="${scalePath(d, vp, far)}" stroke-width="${D}" opacity="${farOpacity}"/>
    ${joins.map((q) => line([p(q, near), p(q, far)], D, `opacity="${farOpacity}"`)).join("")}
    <path d="${scalePath(d, vp, near)}" stroke-width="${w}"${fill ? ' fill="#0f1620"' : ""}/>`;
}

// Seat side profile: cushion to the left (front of the car), reclined back on the right.
const SEAT = "M60 98 C55 95 55 88 60 86 L109 82 C115 81 117 78 117 73 L121 37 C122 30 127 28 132 30 C136 32 137 35 136 40 L132 88 C131 94 127 96 121 96 Z";
const SEAT_JOINS = [[60, 86], [109, 82], [121, 37], [133, 30]];
const HEADREST = "M118 25 C118 15 121 13 128 13 C135 13 138 15 138 22 C138 26 136 27 128 27 C121 27 118 27 118 25 Z";
const headrest = (vp, near, far) => extrude(HEADREST, vp, near, far, [[118, 20], [138, 20]], { fill: true }) +
  line([toward(vp)([123, 27], near), toward(vp)([122, 31], near)], D) + line([toward(vp)([133, 27], near), toward(vp)([133, 30], near)], D);

// Front row through the driver's door: dash and steering wheel ahead (left), the driver seat
// side-on with its far side behind it, the console, then the passenger seat across the car.
function frontRow({ wheel }) {
  const vp = [100, 50];
  const p = toward(vp);
  const DASH = "M14 30 C24 29 34 31 39 37 L37 60 C31 64 23 66 16 66";
  const glovebox = wheel ? "" : poly([p([20, 46], 0.7), p([36, 46], 0.7), p([35, 56], 0.7), p([20, 57], 0.7)], D);
  // Steering wheel seen from the side door: a tilted ring with its spokes and column.
  const steering = wheel ? `
    <g transform="rotate(-16 58 44)">
      <ellipse cx="58" cy="44" rx="8.5" ry="18" stroke-width="${W}"/>
      <ellipse cx="58.6" cy="44" rx="5.6" ry="14.2" stroke-width="${D}"/>
      <ellipse cx="59.4" cy="45" rx="2.6" ry="4.6" stroke-width="${D}"/>
      ${line([[59, 40.5], [58.8, 30]], D)}${line([[57.4, 47.5], [54.2, 56]], D)}${line([[61.4, 47.5], [63.4, 56.4]], D)}
    </g>
    ${line([[56, 52], [40, 56]], W)}${line([[55, 56], [39, 59]], D, 'opacity=".7"')}` : "";
  const CONSOLE = "M60 72 L114 70 L114 82 L60 84 Z";
  const shifter = p([90, 70], 0.64);
  return `
    ${doorway()}
    ${line([[14, 30], [30, 7]], D)}${line([p([14, 30], 0.32), p([30, 7], 0.32)], F, 'opacity=".6"')}
    ${extrude(SEAT, vp, 0.5, 0.4, SEAT_JOINS, { farOpacity: 0.55 })}
    ${extrude(CONSOLE, vp, 0.7, 0.58, [[60, 72], [114, 70]], { farOpacity: 0.7, fill: true })}
    ${line([shifter, [shifter[0], shifter[1] - 7]], D)}<circle cx="${r1(shifter[0])}" cy="${r1(shifter[1] - 9)}" r="2" stroke-width="${D}"/>
    ${extrude(DASH, vp, 1, 0.32, [[14, 30], [39, 37], [37, 60]], { farOpacity: 0.7 })}
    ${glovebox}
    ${line([[16, 66], [20, 104]], D, 'opacity=".7"')}
    ${poly([[22, 101], [58, 101], p([58, 101], 0.62), p([22, 101], 0.62)], D)}
    ${wheel ? `${poly([[33, 70], [37, 70], [39, 79], [35, 79]], D)}${poly([[43, 69], [48, 69], [50, 76], [45, 76]], D)}` : ""}
    ${steering}
    ${extrude(SEAT, vp, 1, 0.8, SEAT_JOINS, { fill: true })}
    ${headrest(vp, 1, 0.8)}
    ${line([[120, 96], [121, 104]], D)}${line([[66, 98], [66, 104]], D)}`;
}

// Rear row through a rear door: back of the front seat on the left, the bench side-on on the
// right with its far end across the car, and the floor between them.
function rearRow({ third = false } = {}) {
  const vp = [90, 50];
  const p = toward(vp);
  const FRONT_BACK = "M30 98 L33 37 C34 30 39 28 44 30 C48 32 49 35 48 40 L45 92 C44 96 40 98 36 98 Z";
  const FRONT_REST = "M30 25 C30 16 33 14 39 14 C45 14 48 16 48 23 C48 27 46 28 39 28 C33 28 30 28 30 25 Z";
  const bench = third
    ? "M64 98 C59 95 59 89 64 87 L109 84 C115 83 117 80 117 75 L120 44 C121 38 126 36 131 38 C135 40 136 43 135 48 L132 89 C131 94 127 96 121 96 Z"
    : SEAT;
  const benchJoins = third ? [[64, 87], [109, 84], [120, 44], [131, 38]] : SEAT_JOINS;
  const rest = third ? "" : headrest(vp, 1, 0.42);
  return `
    ${doorway()}
    ${poly([p([60, 22], 0.42), p([128, 22], 0.42), p([128, 56], 0.42), p([60, 56], 0.42)], F, 'opacity=".55"')}
    ${extrude(bench, vp, 1, 0.42, benchJoins, { fill: true })}
    ${rest}
    ${line([p([86, 84], 0.7), p([88, 74], 0.7)], F, 'opacity=".5"')}
    ${line([[48, 104], [54, 96], p([54, 96], 0.55)], D)}
    ${extrude(FRONT_BACK, vp, 1, 0.62, [[33, 37], [44, 30], [45, 92]], { fill: true })}
    ${extrude(FRONT_REST, vp, 1, 0.62, [[30, 20], [48, 20]], { fill: true })}
    ${poly([[34, 58], [45, 58], [44, 82], [33, 82]], D)}${line([[33, 63], [45, 63]], F, 'opacity=".6"')}
    ${third ? `<path d="M128 104 Q131 88 150 86" stroke-width="${D}" opacity=".75"/>` : ""}`;
}

/* ------------------------------------------------------------------ exteriors */

// Front ¾ (passenger side): the front face on the left, the side running away to the right.
// The same body mirrored with a rear face gives the rear ¾ from the driver side.
function threeQuarter({ rear = false } = {}) {
  const face = rear
    ? `${poly([[14, 64], [24, 65], [24, 71], [14, 70]], D)}${poly([[42, 68], [52, 69], [52, 75], [42, 74]], D)}
       ${poly([[27, 72], [38, 73.5], [38, 78], [27, 76.5]], D)}
       ${line([[13, 61], [52, 66]], D, 'opacity=".7"')}`
    : `${poly([[13, 63], [21, 64], [21, 69], [13, 68]], D)}${poly([[44, 66.5], [53, 68], [53, 73], [44, 71.5]], D)}
       ${poly([[24, 69], [41, 71.5], [41, 80], [24, 77.5]], D)}${line([[24, 73.5], [41, 76]], F, 'opacity=".6"')}`;
  return `
    ${line([[8, 98], [60, 104], [154, 92]], F, 'opacity=".35"')}
    ${poly([[12, 60], [52, 65], [53, 96], [13, 88]])}
    ${line([[13, 82], [53, 89]], D)}
    ${face}
    ${poly([[12, 60], [52, 65], [82, 55], [42, 51]], W)}
    ${poly([[42, 51], [82, 55], [94, 36], [58, 33]], W)}
    ${line([[58, 33], [104, 30], [130, 34]], D)}${line([[94, 36], [128, 35]], W)}
    ${line([[128, 35], [148, 50]], W)}${line([[130, 34], [148, 46]], D, 'opacity=".7"')}
    ${line([[82, 55], [148, 51], [153, 60], [151, 86]], W)}
    ${line([[53, 96], [62, 96.5]], W)}${line([[82, 94.5], [122, 91]], W)}${line([[141, 88.5], [151, 86]], W)}
    <path d="M62 96.5 A11 13 0 0 1 82 94.5" stroke-width="${W}"/><path d="M122 91 A10 12 0 0 1 141 88.5" stroke-width="${W}"/>
    <ellipse cx="72" cy="96" rx="8" ry="11" stroke-width="${W}"/><ellipse cx="72.5" cy="96" rx="4" ry="5.5" stroke-width="${D}"/>
    <ellipse cx="131.5" cy="90" rx="7" ry="9.5" stroke-width="${W}"/><ellipse cx="132" cy="90" rx="3.5" ry="4.7" stroke-width="${D}"/>
    ${poly([[86, 53], [96, 39], [113, 38], [113, 52.5]], D)}${poly([[117, 38], [127, 38], [142, 50.5], [117, 52]], D)}
    ${line([[85, 56], [85, 93.5]], D, 'opacity=".75"')}${line([[115, 53], [115, 91.5]], D, 'opacity=".75"')}
    ${line([[100, 60], [106, 59.6]], D)}${line([[127, 58.5], [133, 58]], D)}
    ${line([[54, 76], [151, 70]], F, 'opacity=".5"')}
    ${poly([[84, 55], [78, 49], [74, 50], [76, 55]], D)}`;
}

const SKETCHES = {
  front_driver: svg(frontRow({ wheel: true })),
  front_passenger: svg(frontRow({ wheel: false }), { mirror: true }),
  // From the back seat between the front seats, looking forward: dash with the screen and
  // radio, vents, the console running toward the camera (shifter, cupholders, armrest),
  // the front seat backs on either side.
  center_console: svg(`
    <path d="M6 46 Q80 30 154 46" stroke-width="${D}" opacity=".75"/>
    <path d="M10 66 Q80 56 150 66"/>
    <path d="M6 46 L10 66 M154 46 L150 66" stroke-width="${D}" opacity=".75"/>
    <ellipse cx="34" cy="54" rx="17" ry="13" stroke-width="${D}" opacity=".8"/>
    <rect x="61" y="27" width="38" height="24" rx="3"/>
    <rect x="64.5" y="30.5" width="31" height="17" rx="1.5" stroke-width="${F}" opacity=".6"/>
    ${poly([[46, 47], [58, 46], [58, 52], [46, 53]], D)}${line([[47, 49.5], [57, 49]], F, 'opacity=".6"')}
    ${poly([[114, 47], [102, 46], [102, 52], [114, 53]], D)}${line([[113, 49.5], [103, 49]], F, 'opacity=".6"')}
    ${poly([[62, 54], [98, 54], [99, 68], [61, 68]], D)}
    <circle cx="68" cy="61" r="3.4" stroke-width="${D}"/><circle cx="92" cy="61" r="3.4" stroke-width="${D}"/>
    ${line([[74, 59], [86, 59]], D)}${line([[74, 63], [86, 63]], D)}
    ${line([[61, 68], [50, 118]])}${line([[99, 68], [110, 118]])}
    ${line([[78, 82], [77, 74]], D)}<ellipse cx="77" cy="72" rx="4" ry="3" stroke-width="${D}"/>
    ${poly([[71, 79], [89, 79], [90, 86], [70, 86]], F, 'opacity=".6"')}
    <ellipse cx="72" cy="94" rx="5.5" ry="3.6" stroke-width="${D}"/><ellipse cx="88" cy="94" rx="5.5" ry="3.6" stroke-width="${D}"/>
    <path d="M54 104 Q80 100 106 104 L108 118 L52 118 Z" stroke-width="${D}"/>
    <path d="M0 56 C14 54 24 58 30 70 L40 118 L0 118 Z" fill="#0f1620"/>
    <path d="M8 26 C8 18 14 16 22 16 C30 16 34 19 34 26 C34 32 30 34 22 34 C14 34 8 32 8 26 Z" fill="#0f1620"/>
    ${line([[14, 34], [12, 56]], D)}${line([[28, 34], [26, 58]], D)}
    <path d="M160 56 C146 54 136 58 130 70 L120 118 L160 118 Z" fill="#0f1620"/>
    <path d="M152 26 C152 18 146 16 138 16 C130 16 126 19 126 26 C126 32 130 34 138 34 C146 34 152 32 152 26 Z" fill="#0f1620"/>
    ${line([[146, 34], [148, 56]], D)}${line([[132, 34], [134, 58]], D)}`),
  rear_driver: svg(rearRow()),
  rear_passenger: svg(rearRow(), { mirror: true }),
  third_driver: svg(rearRow({ third: true })),
  third_passenger: svg(rearRow({ third: true }), { mirror: true }),

  // Hatch/trunk fully open, seen from behind: the opening, seatbacks at the far end and
  // the whole cargo floor.
  trunk: svg(`
    ${poly([[26, 4], [134, 4], [146, 18], [14, 18]], D)}
    ${line([[14, 18], [8, 92], [152, 92], [146, 18]])}
    ${poly([[40, 36], [120, 36], [124, 66], [36, 66]], D)}
    ${poly([[48, 28], [66, 28], [66, 36], [48, 36]], D)}${poly([[94, 28], [112, 28], [112, 36], [94, 36]], D)}
    ${line([[80, 36], [80, 66]], F, 'opacity=".6"')}
    ${line([[36, 66], [14, 90]], D)}${line([[124, 66], [146, 90]], D)}
    ${line([[14, 18], [40, 36]], F, 'opacity=".6"')}${line([[146, 18], [120, 36]], F, 'opacity=".6"')}
    ${line([[24, 78], [136, 78]], F, 'opacity=".45" stroke-dasharray="4 4"')}
    ${poly([[2, 30], [9, 30], [8, 58], [2, 58]], D)}${poly([[158, 30], [151, 30], [152, 58], [158, 58]], D)}
    ${line([[6, 92], [6, 104], [154, 104], [154, 92]])}
    ${poly([[66, 96], [94, 96], [94, 102], [66, 102]], D)}`),

  // Front of the car, straight on, from a few steps back.
  ext_front: svg(`
    ${line([[10, 107], [150, 107]], F, 'opacity=".35"')}
    ${poly([[53, 26], [107, 26], [120, 50], [40, 50]])}
    ${line([[56, 30], [104, 30]], F, 'opacity=".5"')}
    ${line([[40, 50], [22, 56], [17, 62], [16, 92], [144, 92], [143, 62], [138, 56], [120, 50]])}
    ${line([[24, 58], [80, 60.5], [136, 58]], D)}
    ${poly([[20, 63], [45, 66], [43, 72], [21, 70]], D)}${poly([[140, 63], [115, 66], [117, 72], [139, 70]], D)}
    <rect x="56" y="65" width="48" height="14" rx="4" stroke-width="${D}"/>${line([[60, 70], [100, 70]], F, 'opacity=".6"')}${line([[60, 74], [100, 74]], F, 'opacity=".6"')}
    <circle cx="80" cy="72" r="2.4" stroke-width="${D}"/>
    ${poly([[70, 81], [90, 81], [90, 86], [70, 86]], D)}
    ${line([[20, 84], [62, 85]], D)}${line([[98, 85], [140, 84]], D)}
    <circle cx="28" cy="79" r="2.3" stroke-width="${D}"/><circle cx="132" cy="79" r="2.3" stroke-width="${D}"/>
    ${poly([[20, 92], [38, 92], [38, 104], [20, 104]])}${poly([[122, 92], [140, 92], [140, 104], [122, 104]])}
    ${poly([[38, 49], [28, 45], [25, 47], [27, 52], [38, 52]], D)}${poly([[122, 49], [132, 45], [135, 47], [133, 52], [122, 52]], D)}
    ${line([[60, 48], [76, 44]], F, 'opacity=".6"')}${line([[84, 48], [100, 44]], F, 'opacity=".6"')}`),

  ext_front_right: svg(threeQuarter()),
  ext_rear_left: svg(threeQuarter({ rear: true }), { mirror: true }),

  // One front wheel filling the frame, camera level with the hub.
  ext_wheel: svg(`
    <path d="M14 30 Q80 -14 146 30" stroke-width="${D}" opacity=".6"/>
    <circle cx="80" cy="62" r="50"/>
    <circle cx="80" cy="62" r="44" stroke-width="${F}" opacity=".5"/>
    <circle cx="80" cy="62" r="34"/>
    <circle cx="80" cy="62" r="24" stroke-width="${F}" opacity=".45"/>
    <circle cx="80" cy="62" r="8" stroke-width="${D}"/>
    ${[0, 72, 144, 216, 288].map((a) => {
      const t = ((a - 90) * Math.PI) / 180;
      const o = 0.16;
      const at = (r, d) => [80 + Math.cos(t + d) * r, 62 + Math.sin(t + d) * r];
      const lug = at(13, 0.63);
      return `${line([at(9, -o * 1.6), at(32, -o)], D)}${line([at(9, o * 1.6), at(32, o)], D)}<circle cx="${r1(lug[0])}" cy="${r1(lug[1])}" r="1.5" stroke-width="${F}"/>`;
    }).join("")}
    <path d="M57 44 A28 28 0 0 1 70 36" stroke-width="5" opacity=".55"/>
    ${[...Array(12)].map((_, i) => {
      const t = (i * 30 * Math.PI) / 180;
      return line([[80 + Math.cos(t) * 46, 62 + Math.sin(t) * 46], [80 + Math.cos(t) * 50, 62 + Math.sin(t) * 50]], F, 'opacity=".55"');
    }).join("")}`),
};

export function photoGuide(key) {
  return SKETCHES[key] || svg(`<rect x="30" y="24" width="100" height="72" rx="8"/><circle cx="80" cy="60" r="16"/>`);
}
