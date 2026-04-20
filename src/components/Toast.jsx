import { memo } from 'react';

function Toast({ message, type = 'info', onDismiss }) {
  if (!message) return null;
  return (
    <div className={`toast toast-${type}`} onClick={onDismiss}>
      <span className="toast-message">{message}</span>
      <button className="toast-dismiss" onClick={onDismiss}>&times;</button>
    </div>
  );
}

export default memo(Toast);
