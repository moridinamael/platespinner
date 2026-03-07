// Lightweight request validation helpers — no external dependencies

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

/**
 * Returns null if valid, or an error message string if invalid.
 */
export function validateStringField(value, fieldName, { maxLength = 5000, required = false } = {}) {
  if (required && (value === undefined || value === null || value === '')) {
    return `${fieldName} is required`;
  }
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string') {
      return `${fieldName} must be a string`;
    }
    if (value.length > maxLength) {
      return `${fieldName} must be ${maxLength} characters or fewer`;
    }
  }
  return null;
}

/**
 * Returns null if valid, or an error message string if not in allowed list.
 */
export function validateEnum(value, fieldName, allowed) {
  if (value !== undefined && value !== null && !allowed.includes(value)) {
    return `${fieldName} must be one of: ${allowed.join(', ')}`;
  }
  return null;
}
