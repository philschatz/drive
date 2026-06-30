import { Switch as RTSwitch } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Switch. `checked` / `onCheckedChange` /
 * `disabled` pass straight through.
 */

export interface SwitchProps {
  className?: string;
  [key: string]: any;
}

function Switch({ className, ...props }: SwitchProps) {
  return <RTSwitch className={className} {...props} />;
}

export { Switch };
