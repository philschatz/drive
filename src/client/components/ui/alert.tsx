import { Callout, Text } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes Callout, preserving the legacy Alert API
 * (variant default/destructive/success + Alert/AlertTitle/AlertDescription).
 * Call-sites style the banner layout via className (flex/justify-between),
 * which wins over Callout's default layout because Themes CSS loads first.
 */

const COLOR: Record<string, any> = {
  default: "gray",
  destructive: "red",
  success: "green",
};

export interface AlertProps {
  variant?: "default" | "destructive" | "success";
  className?: string;
  children?: any;
  [key: string]: any;
}

function Alert({ variant = "default", className, children, ...props }: AlertProps) {
  return (
    <Callout.Root role="alert" color={COLOR[variant] ?? "gray"} className={className} {...props}>
      {children}
    </Callout.Root>
  );
}

function AlertTitle({ children, ...props }: { className?: string; children?: any; [k: string]: any }) {
  return (
    <Text as="div" weight="bold" {...(props as any)}>
      {children}
    </Text>
  );
}

function AlertDescription({ children, ...props }: { className?: string; children?: any; [k: string]: any }) {
  return <Callout.Text {...(props as any)}>{children}</Callout.Text>;
}

export { Alert, AlertTitle, AlertDescription };
