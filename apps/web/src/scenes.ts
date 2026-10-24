import type { Card, Course } from '@understandity/contracts';
import { esc } from './app.js';

/**
 * Scene art for the learner. A pre-rendered picture (`worlds[].image`, e.g. `/media/<course>/<card>-<world>.png`)
 * always wins; until it exists we draw an original SVG scheme in the Ocean lab palette, so new PNGs replace the
 * scheme without touching code. Physics schemes follow the Ocean lab prototype; math and biology get their own.
 */
type Kind = 'ship' | 'wood' | 'cut' | 'hull' | 'ab' | 'grid' | 'plant' | 'water';

/** Card id → scheme for the courses we know; anything else falls back by subject. */
const BY_CARD: Record<string, Kind> = {
  'c1-weight-vs-density': 'ship',
  'c2-the-rule-of-1-g-cm3': 'wood',
  'c3-cutting-the-stone': 'cut',
  'c4-the-secret-of-the-ship': 'hull',
  'c5-the-density-challenge': 'ab',
  'half-block': 'cut',
  'plasticine-boat': 'hull',
};

function kindOf(course: Course | null, card: Card | null, index: number): Kind {
  if (card && BY_CARD[card.id]) return BY_CARD[card.id]!;
  const subject = course?.subject.toLowerCase() ?? '';
  if (subject.startsWith('math')) return 'grid';
  if (subject.startsWith('bio')) return 'plant';
  if (subject.startsWith('phys')) return (['ship', 'wood', 'cut', 'hull', 'ab'] as Kind[])[index % 5]!;
  return 'water';
}

const T = (x: number, y: number, t: string, size = 16, fill = '#241E31', anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="JetBrains Mono, monospace" font-size="${size}" font-weight="700" fill="${fill}" text-anchor="${anchor}">${esc(t)}</text>`;

const SKY = '<path d="M0 0H640V460H0Z" fill="#E5DFF5"/><circle cx="528" cy="105" r="35" fill="#F1E5D3"/><path d="M70 118H170M105 132H205M445 170H527" stroke="#FBFAFE" stroke-width="3"/>';
const WATER =
  '<path d="M0 265Q80 255 160 265T320 265T480 265T640 265V460H0Z" fill="#BBDDD8"/><path d="M0 285Q80 275 160 285T320 285T480 285T640 285" fill="none" stroke="#0E7C86" opacity=".35" stroke-width="2"/><path d="M36 330H106M485 310H570M385 412H475M95 406H150" stroke="#0E7C86" opacity=".23" stroke-width="2"/>';

const rock = (x: number, y: number, s = 1) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="m0 26 22-26 43 8 20 32-33 22-42-9Z" fill="#746982"/><path d="m0 26 34 1L22 0 65 8 34 27 52 62 10 53Z" fill="#9586A4"/><path d="m34 27 51 13-33 22Z" fill="#5E526E"/></g>`;

const boat = (cut: boolean) =>
  `<g><path d="M124 234 163 288 402 288 482 234Z" fill="#6D55C8"/><path d="m124 234 39 54h239l-13 18H177l-40-39Z" fill="#514094"/><path d="m145 224 294-8 43 18H124Z" fill="#FBFAFE"/><path d="M208 169H360V223H208Z" fill="#FBFAFE"/><path d="m208 169 31-16h128l-7 16Z" fill="#F1E5D3"/><path d="M360 169 367 153V208L360 223Z" fill="#C9BDD9"/><path d="M249 121H278V153H249Z" fill="#C2571A"/><path d="M243 116H284V126H243Z" fill="#241E31"/><path d="M277 111V91M288 99V79M298 89V67" stroke="#9586A4" stroke-width="5"/><path d="M224 181H244V199H224ZM259 181H279V199H259ZM294 181H314V199H294ZM329 181H345V199H329Z" fill="#0E7C86"/><path d="M391 143V222M391 145l42 14-42 14Z" fill="#C2571A" stroke="#241E31" stroke-width="2"/>${
    cut
      ? '<path d="m183 247 28 30h170l42-30Z" fill="#F1F0F5"/><path d="m211 277 13-26M259 277l4-26M310 277v-26M356 277l-4-26" stroke="#B4AEC2" stroke-width="2"/>'
      : ''
  }<path d="M146 294q75 12 150 0t150 0" fill="none" stroke="#0E7C86" stroke-width="4"/></g>`;

function art(kind: Kind, labels: boolean): string {
  switch (kind) {
    case 'ship':
    case 'hull': {
      let a = SKY + WATER + boat(kind === 'hull') + rock(471, 347, 0.6);
      if (labels) {
        a += T(83, 197, 'STEEL', 12) + T(83, 213, 'SHIP', 12) + '<path d="M101 223v20h32" fill="none" stroke="#241E31" stroke-width="1.5"/>' + T(503, 335, 'PEBBLE', 12, '#085762', 'middle');
        if (kind === 'hull') a += T(290, 350, 'AIR INSIDE', 16, '#085762', 'middle') + '<path d="M290 331v-47" stroke="#085762" stroke-width="1.5" stroke-dasharray="4 5"/>';
      }
      return a;
    }
    case 'wood': {
      let a =
        SKY +
        WATER +
        '<path d="m91 222 106-30 87 31-105 34Z" fill="#E2BD89"/><path d="m91 222 88 35v51l-88-35Z" fill="#BD8F61"/><path d="m179 257 105-34v50l-105 35Z" fill="#D3A773"/><path d="m110 238 51 18m-51-5 51 18m34-4 70-23" stroke="#805F43" stroke-width="2" opacity=".5"/>' +
        rock(395, 335, 1.3);
      if (labels) a += T(181, 169, 'WOOD', 16, '#241E31', 'middle') + T(450, 318, 'STONE', 16, '#085762', 'middle');
      return a;
    }
    case 'cut': {
      let a = SKY + WATER + rock(118, 309, 1.4) + rock(390, 335, 0.8) + rock(460, 355, 0.65) + '<path d="M270 339h77m-12-9 12 9-12 9" stroke="#0E7C86" fill="none" stroke-width="3"/>';
      if (labels) a += T(190, 219, 'ONE STONE', 16, '#241E31', 'middle') + T(454, 219, 'TWO PIECES', 16, '#241E31', 'middle') + T(320, 112, 'What changes?', 24, '#6D55C8', 'middle');
      return a;
    }
    case 'ab': {
      let a =
        SKY +
        WATER +
        '<path d="M92 215 180 186 268 215 180 244Z" fill="#C5B4EC"/><path d="M92 215 180 244V330L92 301Z" fill="#6D55C8"/><path d="M180 244 268 215V301L180 330Z" fill="#9279CC"/><path d="M403 239 460 220 517 239 460 258Z" fill="#DCC2A3"/><path d="M403 239 460 258V315L403 296Z" fill="#AD825B"/><path d="M460 258 517 239V296L460 315Z" fill="#C39A70"/>' +
        T(180, 154, 'A', 32, '#6D55C8', 'middle') +
        T(460, 169, 'B', 32, '#6D55C8', 'middle');
      if (labels) a += T(180, 365, '400 g / 500 cm³', 16, '#085762', 'middle') + T(460, 365, '150 g / 100 cm³', 16, '#085762', 'middle');
      return a;
    }
    case 'grid': {
      // One square and the square with a doubled side: four times the tiles, not two.
      const cell = (x: number, y: number, fill: string) => `<path d="M${x} ${y}h44v44h-44Z" fill="${fill}" stroke="#FBFAFE" stroke-width="3"/>`;
      let a = '<path d="M0 0H640V460H0Z" fill="#E5DFF5"/><path d="M0 330H640V460H0Z" fill="#DCEDEA"/>';
      a += cell(120, 222, '#6D55C8');
      for (const [dx, dy] of [[0, 0], [44, 0], [0, 44], [44, 44]] as const) a += cell(370 + dx, 178 + dy, dx || dy ? '#9279CC' : '#6D55C8');
      a += '<path d="M200 244h120m-14-10 14 10-14 10" stroke="#0E7C86" fill="none" stroke-width="3"/>';
      if (labels) a += T(142, 300, '1 × 1', 16, '#241E31', 'middle') + T(414, 300, '2 × 2', 16, '#241E31', 'middle') + T(320, 120, 'Side ×2 → tiles ?', 22, '#6D55C8', 'middle');
      return a;
    }
    case 'plant': {
      let a = SKY + '<path d="M0 330H640V460H0Z" fill="#D3A773"/><path d="M0 330H640" stroke="#BD8F61" stroke-width="4"/>';
      a +=
        '<path d="M320 330V190" stroke="#0E7A55" stroke-width="8"/><path d="M320 250q-70-10-90-60 60 0 90 50Z" fill="#3E9A6B"/><path d="M320 220q70-10 95-60-65 0-95 50Z" fill="#3E9A6B"/><path d="M320 190q-20-40 0-70 20 30 0 70Z" fill="#52B07F"/>';
      a += '<path d="M320 330v50m0-30-28 36m28-20 30 40" stroke="#805F43" stroke-width="4" fill="none"/>';
      a += '<path d="M490 135 410 185" stroke="#C2571A" stroke-width="3" stroke-dasharray="6 6"/><path d="M150 170 245 205" stroke="#0E7C86" stroke-width="3"/><path d="M215 395 292 368" stroke="#0E7C86" stroke-width="3"/>';
      if (labels) a += T(150, 160, 'CO₂', 16, '#085762', 'middle') + T(195, 420, 'WATER', 14, '#085762', 'middle') + T(520, 175, 'LIGHT', 14, '#C2571A', 'middle');
      return a;
    }
    case 'water':
      return SKY + WATER;
  }
}

export interface SceneArt {
  /** HTML for the art slot: `<img>` for a ready picture, inline SVG otherwise. */
  html: string;
  /** True when a real illustration is shown (no scheme). */
  picture: boolean;
}

/** Only same-origin media or data URLs are rendered; anything else falls back to the scheme. */
const safe = (src: string | null | undefined) => (src && /^(\/media\/|data:image\/|blob:)/.test(src) ? src : null);

export function sceneArt(opts: { course: Course | null; card: Card | null; index: number; world: string; labels?: boolean; fit?: 'slice' | 'meet' }): SceneArt {
  const { course, card, index, world } = opts;
  const scene = card?.worlds.find((w) => w.world === world) ?? card?.worlds[0];
  const img = safe(scene?.image);
  if (img) return { html: `<img src="${esc(img)}" alt="${esc(scene?.illustration ?? '')}">`, picture: true };
  const kind = kindOf(course, card, index);
  return {
    html: `<svg viewBox="0 0 640 460" xmlns="http://www.w3.org/2000/svg" role="img" preserveAspectRatio="xMidYMid ${opts.fit ?? 'slice'}" aria-label="${esc(scene?.illustration ?? card?.title ?? '')}">${art(kind, opts.labels !== false)}</svg>`,
    picture: false,
  };
}
