import * as RI from "@radix-ui/react-icons";

/**
 * Maps the Material Symbols glyph names the app used to @radix-ui/react-icons
 * components. Centralizing this keeps the (many) call-sites terse and lets the
 * datagrid CommandBar render icons from dynamic `entry.icon` strings, which
 * react-icons can't do directly. Unknown names fall back to a neutral dot.
 */
const MAP: Record<string, keyof typeof RI> = {
  // navigation / generic
  arrow_back: "ArrowLeftIcon",
  arrow_upward: "ArrowUpIcon",
  arrow_downward: "ArrowDownIcon",
  keyboard_arrow_down: "ChevronDownIcon",
  keyboard_arrow_up: "ChevronUpIcon",
  keyboard_arrow_left: "ChevronLeftIcon",
  keyboard_arrow_right: "ChevronRightIcon",
  unfold_more: "CaretSortIcon",
  menu: "HamburgerMenuIcon",
  close: "Cross2Icon",
  search: "MagnifyingGlassIcon",
  settings: "GearIcon",
  add: "PlusIcon",
  remove: "MinusIcon",
  delete: "TrashIcon",
  edit: "Pencil1Icon",
  download: "DownloadIcon",
  refresh: "ReloadIcon",
  update: "UpdateIcon",
  undo: "ResetIcon",
  redo: "ReloadIcon",
  history: "CounterClockwiseClockIcon",
  fast_forward: "DoubleArrowRightIcon",
  code: "CodeIcon",
  lock: "LockClosedIcon",
  check_circle: "CheckCircledIcon",
  error: "CrossCircledIcon",
  warning: "ExclamationTriangleIcon",
  date_range: "CalendarIcon",
  calendar_month: "CalendarIcon",
  grid: "ViewGridIcon",
  checklist: "ListBulletIcon",
  contacts: "PersonIcon",
  person_add: "PersonIcon",
  // devices
  devices: "LaptopIcon",
  smartphone: "MobileIcon",
  install_mobile: "MobileIcon",
  // datagrid: structure
  grid_on: "ViewGridIcon",
  table: "TableIcon",
  border_all: "BorderAllIcon",
  table_rows: "RowsIcon",
  view_column: "ColumnsIcon",
  height: "HeightIcon",
  width: "WidthIcon",
  push_pin: "DrawingPinIcon",
  tag: "BoxIcon", // "Number format" submenu — no exact Radix match
  auto_awesome: "MagicWandIcon",
  visibility: "EyeOpenIcon",
  visibility_off: "EyeClosedIcon",
  content_copy: "CopyIcon",
  content_cut: "ScissorsIcon",
  content_paste: "ClipboardIcon",
  // datagrid: text formatting
  format_bold: "FontBoldIcon",
  format_italic: "FontItalicIcon",
  format_underlined: "UnderlineIcon",
  format_strikethrough: "StrikethroughIcon",
  format_size: "FontSizeIcon",
  font_download: "FontFamilyIcon",
  format_align_left: "TextAlignLeftIcon",
  format_align_center: "TextAlignCenterIcon",
  format_align_right: "TextAlignRightIcon",
  format_clear: "TextNoneIcon",
  format_color_fill: "ColorWheelIcon",
  format_color_text: "TextIcon",
  format_color_reset: "ResetIcon",
  // access levels (AccessIcon) + progress steps (RendezvousProgress)
  admin_panel_settings: "GearIcon",
  progress_activity: "UpdateIcon",
  radio_button_unchecked: "CircleIcon",
  share: "Share1Icon",
  bell: "BellIcon",
  group: "GroupIcon",
  check: "CheckIcon",
  help: "QuestionMarkCircledIcon",
};

function toPx(size: number | string | undefined): number {
  if (typeof size === "number") return size;
  if (typeof size === "string") {
    if (size.endsWith("rem")) return parseFloat(size) * 16;
    if (size.endsWith("px")) return parseFloat(size);
    const n = parseFloat(size);
    if (!Number.isNaN(n)) return n;
  }
  return 18;
}

export interface IconProps {
  /** Material Symbols glyph name (legacy) — mapped to a react-icon. */
  name: string;
  /** Pixel size, or a CSS rem/px string. Default 18 to match the old font size. */
  size?: number | string;
  className?: string;
  title?: string;
  [k: string]: any;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const Cmp = (RI as any)[MAP[name]] ?? RI.DotFilledIcon;
  const px = toPx(size);
  return <Cmp width={px} height={px} {...props} />;
}
