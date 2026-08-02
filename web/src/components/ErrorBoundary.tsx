import { Component, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
        <div className="flex min-h-svh items-center justify-center bg-background p-6">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Something went wrong</CardTitle>
              <CardDescription>{this.state.error.message}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => location.reload()}>Reload</Button>
            </CardContent>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
