import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last-resort catch: without this, any render error unmounts the whole
 * tree and leaves nothing but the dark theme's background — a silent
 * "black screen" with no clue what happened. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Signal crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <div className="error-screen-card">
            <h1>Something went wrong</h1>
            <p>{this.state.error.message}</p>
            <button onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
