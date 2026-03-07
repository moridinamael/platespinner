import { useState } from 'react';
import { api } from '../api.js';

export default function LoginScreen({ onSuccess }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(token);
      onSuccess();
    } catch {
      setError('Invalid token');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-form" onSubmit={handleSubmit}>
        <h2>PlateSpinner</h2>
        <p>Enter your API token to continue.</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="APP_API_TOKEN"
          autoFocus
          required
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={loading || !token}>
          {loading ? 'Authenticating...' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
