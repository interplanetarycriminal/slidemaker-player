/* ============================================================
   SlideMaker — shared theme / skin switcher (ES module)

   - persists the chosen skin in localStorage "slidemaker.theme"
   - applies it via <html data-theme="ID"> as early as possible
   - a tiny inline snippet in each page <head> sets the attribute
     BEFORE the stylesheets paint, so there is no flash of the
     default skin on reload (this module is a no-op re-apply plus
     the <select> wiring)
   - initTheme() populates #themeSelect and wires change events,
     dispatching a 'themechange' CustomEvent on window
   ============================================================ */

export const STORAGE_KEY = "slidemaker.theme";
export const DEFAULT_THEME = "phosphor";

/* id -> label. The leading glyph is a cheap inline "swatch".
   `group` buckets each skin under an <optgroup> in the switcher:
   the original six are palette-only "Colour skins"; the six new
   ones are structurally distinct "Designed skins" (texture,
   typography, decoration, frame treatment — see css/themes.css). */
export const GROUPS = {
  colour:   "— Colour skins —",
  designed: "— Designed skins —",
};

export const THEMES = [
  { id: "phosphor",   group: "colour",   label: "◉ Phosphor" },   /* ◉ */
  { id: "amber",      group: "colour",   label: "◉ Amber" },
  { id: "blueprint",  group: "colour",   label: "◉ Blueprint" },
  { id: "paper",      group: "colour",   label: "◉ Paper" },
  { id: "synthwave",  group: "colour",   label: "◉ Synthwave" },
  { id: "solarpunk",  group: "colour",   label: "◉ Solarpunk" },
  { id: "instrument", group: "designed", label: "◈ Instrument" },
  { id: "dither",     group: "designed", label: "◈ Dither" },
  { id: "orrery",     group: "designed", label: "◈ Orrery" },
  { id: "draftsman",  group: "designed", label: "◈ Draftsman" },
  { id: "brutalist",  group: "designed", label: "◈ Brutalist" },
  { id: "aperture",   group: "designed", label: "◈ Aperture" },
];

const VALID = new Set(THEMES.map((t) => t.id));

/** Read the saved skin id, falling back to the default. */
export function getSavedTheme() {
  let id = null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* localStorage may be unavailable (privacy mode) — ignore */
  }
  return id && VALID.has(id) ? id : DEFAULT_THEME;
}

/** Apply a skin to <html>. Unknown ids fall back to the default. */
export function applyTheme(id) {
  const theme = VALID.has(id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
}

/** Persist + apply + notify. */
export function setTheme(id) {
  const theme = applyTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore write failures */
  }
  window.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  return theme;
}

/**
 * Boot the switcher for a page.
 * - re-applies the saved skin (the inline head snippet already set it)
 * - if a <select id="themeSelect"> exists, fills it and wires change
 * Safe to call once on load from either page.
 */
export function initTheme() {
  const current = getSavedTheme();
  applyTheme(current);

  const select = document.getElementById("themeSelect");
  if (select) {
    if (!select.options.length) {
      /* build one <optgroup> per bucket, in declaration order */
      const groups = new Map();
      for (const t of THEMES) {
        let og = groups.get(t.group);
        if (!og) {
          og = document.createElement("optgroup");
          og.label = GROUPS[t.group] || t.group;
          groups.set(t.group, og);
          select.appendChild(og);
        }
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.label;
        og.appendChild(opt);
      }
    }
    select.value = current;
    select.addEventListener("change", () => setTheme(select.value));
  }

  return current;
}

export default initTheme;
