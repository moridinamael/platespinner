import { useEffect, useRef } from 'react';
import { WebSocketManager } from '../api.js';

export function useWebSocket(onMessage) {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const manager = new WebSocketManager((event, data) => {
      handlerRef.current(event, data);
    });
    return () => manager.disconnect();
  }, []);
}
