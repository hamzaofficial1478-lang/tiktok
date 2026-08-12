import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './primitives';

/**
 * Keeps one broken screen from taking down the window.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which presents as the app going black — header, navigation and all — with no
 * clue as to what happened and no way back except restarting. That is a far
 * worse failure than the bug causing it, and it hides the bug too.
 *
 * Resetting on `screenKey` means switching tabs recovers: only the screen that
 * threw stays broken, and the rest of the app keeps working.
 */

interface Props {
  readonly children: ReactNode;
  /** Changing this clears the error — used to recover on navigation. */
  readonly screenKey: string;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  readonly error: Error | null;
  readonly screenKey: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, screenKey: props.screenKey };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.screenKey !== state.screenKey) return { error: null, screenKey: props.screenKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also goes to the terminal running `npm run dev`, where the stack is
    // clickable back to the source line.
    console.error('[renderer] screen crashed', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-lg rounded-xl border border-danger-400/30 bg-danger-400/10 p-6">
          <p className="font-medium text-danger-400">This screen hit a problem</p>
          <p className="mt-2 text-sm text-ink-300">
            The rest of the app is still running — downloads in progress were not interrupted. Switch to
            another screen and back, or reload.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-base-900/60 p-3 font-mono text-xs text-ink-500">
            {error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(`${error.message}\n\n${error.stack ?? ''}`);
              }}
            >
              Copy details
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
