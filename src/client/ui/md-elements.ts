/**
 * Registers the @material/web (Material Design 3) custom elements used by the app.
 *
 * These are Lit-based web components — importing the module registers the custom
 * element as a side effect. Imported once from main.tsx (after globals.css, so the
 * MD3 `--md-sys-color-*` tokens defined there are already in scope). Per-component
 * imports keep the bundle tree-shakeable — add a line here when a new md-* tag is used.
 *
 * NOTE: md-* components render into Shadow DOM, so Tailwind utility classes do NOT
 * reach their internals. Style them via their documented CSS custom properties or the
 * shared `--md-sys-*` tokens; use Tailwind only on surrounding wrapper layout.
 */
import '@material/web/fab/fab.js';
import '@material/web/list/list.js';
import '@material/web/list/list-item.js';
import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/icon/icon.js';
import '@material/web/checkbox/checkbox.js';
import '@material/web/slider/slider.js';
import '@material/web/switch/switch.js';
import '@material/web/divider/divider.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
