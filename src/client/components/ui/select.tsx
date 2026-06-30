import { Select as RTSelect } from "@radix-ui/themes";

/**
 * Thin re-exports of @radix-ui/themes Select. Note the API differs from the old
 * shadcn wrapper: there is no SelectValue — the placeholder lives on
 * <SelectTrigger placeholder="…" />. The SelectValue shim below renders nothing
 * and exists only so any stragglers don't crash; call-sites should drop it.
 */

const Select = RTSelect.Root;
const SelectGroup = RTSelect.Group;

// Force popper positioning. Radix Select defaults to "item-aligned", whose
// JS-driven positioning fails under preact/compat (the content renders in static
// flow at the top of the page instead of anchored to the trigger). "popper" uses
// floating-ui — the same path DropdownMenu uses successfully here — and adds the
// .rt-PopperContent class so the globals.css z-index lift applies.
function SelectContent({ position = "popper", ...props }: any) {
  return <RTSelect.Content position={position} {...props} />;
}

const SelectItem = RTSelect.Item;
const SelectLabel = RTSelect.Label;
const SelectSeparator = RTSelect.Separator;
const SelectTrigger = RTSelect.Trigger;

/** @deprecated Themes Select has no value component — set `placeholder` on SelectTrigger. */
const SelectValue = (_props: { placeholder?: string }) => null;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
};
