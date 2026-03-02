import { useState, useRef, useEffect, useCallback } from 'react';

export function useConfirm(timeout = 3000) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  const arm = useCallback(() => {
    setConfirming(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setConfirming(false), timeout);
  }, [timeout]);

  const reset = useCallback(() => {
    clearTimeout(timerRef.current);
    setConfirming(false);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return [confirming, arm, reset];
}
