import { Progress as RTProgress } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Progress. Takes a 0–100 `value`.
 */

export interface ProgressProps {
  className?: string;
  value?: number;
  [key: string]: any;
}

function Progress({ className, value, ...props }: ProgressProps) {
  return <RTProgress className={className} value={value ?? 0} max={100} {...props} />;
}

export { Progress };
