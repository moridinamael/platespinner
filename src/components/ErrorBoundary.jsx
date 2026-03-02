import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error(`[ErrorBoundary${this.props.name ? `: ${this.props.name}` : ''}]`, error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className={`error-boundary ${this.props.className || ''}`}>
          <div className="error-boundary-content">
            <span className="error-boundary-icon">⚠</span>
            <span className="error-boundary-message">
              {this.props.name ? `${this.props.name} crashed` : 'Something went wrong'}
            </span>
            <button className="btn btn-sm error-boundary-retry" onClick={this.handleRetry}>
              Retry
            </button>
          </div>
          <details className="error-boundary-details">
            <summary>Details</summary>
            <pre>{this.state.error?.message || 'Unknown error'}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
