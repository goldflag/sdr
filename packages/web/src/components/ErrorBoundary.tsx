// Top-level error boundary: a render crash anywhere in the tree (canvas, map,
// panel) otherwise unmounts the whole app to a blank page. Shows the error and
// offers a reload instead.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] render crash:", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
        <div className="text-sm font-medium">
          Something went wrong rendering the app.
        </div>
        <pre className="max-h-48 max-w-2xl overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          className="rounded-md border bg-secondary px-4 py-1.5 text-sm text-secondary-foreground hover:bg-accent"
        >
          Reload
        </button>
      </div>
    );
  }
}
