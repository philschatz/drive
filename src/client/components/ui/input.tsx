import { TextField } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes TextField.Root. In Themes v3 the input element
 * IS TextField.Root, so props (value, onInput, type, placeholder, disabled…)
 * pass straight through.
 */

export interface InputProps {
  className?: string;
  type?: string;
  [key: string]: any;
}

function Input({ className, ...props }: InputProps) {
  return <TextField.Root className={className} {...(props as any)} />;
}

export { Input };
