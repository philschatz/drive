import { Text } from "@radix-ui/themes";

/**
 * Adapter rendering a styled <label> via @radix-ui/themes Text.
 */

export interface LabelProps {
  className?: string;
  children?: any;
  [key: string]: any;
}

function Label({ className, children, ...props }: LabelProps) {
  return (
    <Text as="label" size="2" weight="medium" className={className} {...props}>
      {children}
    </Text>
  );
}

export { Label };
