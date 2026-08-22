// 🎁 Power-up icon sprites - SVGs from /public/icons baked ONCE into offscreen
// canvases, then drawn with a single blit per frame (same philosophy as the
// baked tank/sun-halo sprites). Emoji glyphs stay as the fallback while an
// icon loads or when a type has no SVG file (x2/x3/hp10/hp15 are text anyway).

const ICON_TYPES = ['cluster', 'fly', 'guided', 'shield', 'teleport', 'tomahawk']; // files present in /public/icons
const KNOWN = new Set(ICON_TYPES);
const BAKE = 96; // bake px - source SVGs are 1254²; largest in-game draw is 28px (≈1.7x oversample @2x DPR)

const sprites = {};        // type -> baked canvas
const requested = new Set(); // one fetch attempt per type, ever

function ensure(type) {
  if (requested.has(type)) return;
  requested.add(type);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = BAKE;
    c.getContext('2d').drawImage(img, 0, 0, BAKE, BAKE); // explicit dest rect - intrinsic-size proof
    sprites[type] = c;
  };
  img.onerror = () => requested.delete(type); // allow a retry if the file appears later (HMR)
  img.src = `/icons/${type}.svg`;
}

/** Eagerly bake every known icon. Idempotent - safe to call from a mount effect. */
export function loadIcons() {
  for (const t of ICON_TYPES) ensure(t);
}

/** True once the icon is baked and drawable. */
export function hasIcon(type) {
  return !!sprites[type];
}

/**
 * Draw the baked icon centred at (x, y) at size s. Returns false when the
 * sprite isn't ready (or doesn't exist) so the caller falls back to emoji.
 */
export function drawIcon(ctx, type, x, y, s) {
  const c = sprites[type];
  if (!c) {
    if (KNOWN.has(type)) ensure(type); // lazy path - icon pops in mid-game on first use
    return false;
  }
  ctx.drawImage(c, x - s / 2, y - s / 2, s, s);
  return true;
}
