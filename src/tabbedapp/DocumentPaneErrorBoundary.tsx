import { Component, type ReactNode } from "react";

type DocumentPaneErrorBoundaryProps = {
  children: ReactNode;
  onCloseDocument: () => void;
};

type DocumentPaneErrorBoundaryState = { error: Error | null };

// A lazy chunk that 404s after a redeploy (or any other uncaught error in one document's own view - the core is large, and this is its only backstop) would otherwise take the whole shell down with it, every other open tab included: Suspense only catches a still-loading promise, not a thrown one. Scoped to a single pane, so the rest of the shell survives and the reader can at least close the one tab that broke. Its caller keys each pane's DocumentTabContent by documentId, so a different document swapped into the same pane position always remounts a fresh boundary rather than reusing one still holding a previous tab's error.
export class DocumentPaneErrorBoundary extends Component<
  DocumentPaneErrorBoundaryProps,
  DocumentPaneErrorBoundaryState
> {
  override state: DocumentPaneErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="tabbedapp-document-pane tabbedapp-document-pane-error">
          <div className="stack">
            <p>This document&rsquo;s view failed to load.</p>
            <div className="row">
              <button onClick={() => window.location.reload()} type="button">
                Reload page
              </button>
              <button onClick={this.props.onCloseDocument} type="button">
                Close this tab
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
