import { forwardRef } from "preact/compat";
import { Button as RTButton, IconButton } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Button. Preserves the legacy shadcn-style
 * `variant`/`size` API so existing call-sites keep working, mapping each to the
 * Themes variant/color/size system. `size="icon"` renders a Themes IconButton.
 */

type Variant =
  | "default"
  | "destructive"
  | "outline"
  | "active"
  | "secondary"
  | "ghost"
  | "link";

type Size = "default" | "sm" | "lg" | "icon";

const VARIANT: Record<string, { variant: any; color?: any }> = {
  default: { variant: "solid" },
  destructive: { variant: "solid", color: "red" },
  outline: { variant: "outline" },
  active: { variant: "soft", color: "blue" },
  secondary: { variant: "soft", color: "gray" },
  ghost: { variant: "ghost" },
  link: { variant: "ghost" },
};

const SIZE: Record<string, "1" | "2" | "3"> = {
  sm: "1",
  default: "2",
  lg: "3",
};

export interface ButtonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children?: any;
  [key: string]: any;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "default", className, children, ...props }, ref) => {
    const v = VARIANT[variant] ?? VARIANT.default;
    if (size === "icon") {
      return (
        <IconButton
          ref={ref as any}
          variant={v.variant}
          color={v.color}
          size="2"
          className={className}
          {...props}
        >
          {children}
        </IconButton>
      );
    }
    return (
      <RTButton
        ref={ref as any}
        variant={v.variant}
        color={v.color}
        size={SIZE[size] ?? "2"}
        className={className}
        {...props}
      >
        {children}
      </RTButton>
    );
  }
);
Button.displayName = "Button";

export { Button };
