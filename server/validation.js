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

/**
 * Express middleware factory that validates req.body against a schema object.
 * Schema keys map field names to rules: { type, required, enum, max, min, maxLength }.
 * Returns 400 on first validation failure, or calls next().
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const body = req.body || {};
    for (const [field, rules] of Object.entries(schema)) {
      const value = body[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        return res.status(400).json({ error: `${field} is required` });
      }

      if (value === undefined || value === null) continue;

      if (rules.type) {
        if (rules.type === 'array') {
          if (!Array.isArray(value)) {
            return res.status(400).json({ error: `${field} must be an array` });
          }
        } else if (typeof value !== rules.type) {
          return res.status(400).json({ error: `${field} must be a ${rules.type}` });
        }
        if (rules.type === 'number' && isNaN(value)) {
          return res.status(400).json({ error: `${field} must be a valid number` });
        }
      }

      if (rules.enum && !rules.enum.includes(value)) {
        return res.status(400).json({ error: `${field} must be one of: ${rules.enum.join(', ')}` });
      }

      if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
        return res.status(400).json({ error: `${field} must be ${rules.maxLength} characters or fewer` });
      }

      if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
        return res.status(400).json({ error: `${field} must be at least ${rules.min}` });
      }
      if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
        return res.status(400).json({ error: `${field} must be at most ${rules.max}` });
      }
    }
    next();
  };
}
