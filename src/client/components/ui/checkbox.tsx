import { Checkbox as RTCheckbox } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Checkbox. `checked` / `onCheckedChange` /
 * `disabled` pass straight through.
 */

export interface CheckboxProps {
  className?: string;
  [key: string]: any;
}

function Checkbox({ className, ...props }: CheckboxProps) {
  return <RTCheckbox className={className} {...props} />;
}

export { Checkbox };
