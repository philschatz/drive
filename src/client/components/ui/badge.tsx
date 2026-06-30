import { Badge as RTBadge } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Badge, preserving the legacy `variant` API.
 */

const VARIANT: Record<string, { variant: any; color?: any }> = {
  default: { variant: "solid" },
  secondary: { variant: "soft", color: "gray" },
  destructive: { variant: "solid", color: "red" },
  outline: { variant: "outline" },
};

export interface BadgeProps {
  variant?: "default" | "secondary" | "destructive" | "outline";
  className?: string;
  children?: any;
  [key: string]: any;
}

function Badge({ variant = "default", className, children, ...props }: BadgeProps) {
  const v = VARIANT[variant] ?? VARIANT.default;
  return (
    <RTBadge variant={v.variant} color={v.color} className={className} {...props}>
      {children}
    </RTBadge>
  );
}

export { Badge };
