import { useState, useEffect } from 'preact/hooks';
import { subscribeValidation, type ValidationError } from '../client/worker-api';

export type { ValidationError };

/**
 * Subscribe to validation results for a document from the worker thread.
 * Returns up to 100 validation errors, updated on every doc change.
 */
export function useDocumentValidation(docId: string | undefined): ValidationError[] {
  const [errors, setErrors] = useState<ValidationError[]>([]);

  useEffect(() => {
    if (!docId) {
      setErrors([]);
      return;
    }
    return subscribeValidation(docId, setErrors);
  }, [docId]);

  return errors;
}
