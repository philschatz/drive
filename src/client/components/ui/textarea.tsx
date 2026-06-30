import { TextArea } from "@radix-ui/themes";

/**
 * Adapter over @radix-ui/themes TextArea.
 */

export interface TextareaProps {
  className?: string;
  [key: string]: any;
}

function Textarea({ className, ...props }: TextareaProps) {
  return <TextArea className={className} {...props} />;
}

export { Textarea };
