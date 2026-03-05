import { useState, useEffect } from 'preact/hooks';
import type { DocHandle } from './automerge';
import { validateDocument } from './schemas';
import type { ValidationError } from './schemas';

export function useDocumentValidation(handle: DocHandle<any> | null): ValidationError[] {
  const [errors, setErrors] = useState<ValidationError[]>([]);

  useEffect(() => {
    if (!handle) {
      setErrors([]);
      return;
    }

    const doc = handle.doc();
    if (doc) {
      setErrors(validateDocument(doc));
    }

    const onChange = () => {
      const d = handle.doc();
      if (d) {
        setErrors(validateDocument(d));
      }
    };

    handle.on('change', onChange);
    return () => {
      handle.off('change', onChange);
    };
  }, [handle]);

  return errors;
}
