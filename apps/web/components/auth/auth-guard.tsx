"use client";

import { useSession } from "@/hooks/use-session";
import { SignInButton } from "./sign-in-button";

export function AuthGuard({
  children,
  loadingFallback,
  unauthenticatedFallback,
}: {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  unauthenticatedFallback?: React.ReactNode;
}) {
  const { loading, isAuthenticated } = useSession();

  if (loading) {
    return <>{loadingFallback ?? <div>Loading...</div>}</>;
  }

  if (!isAuthenticated) {
    return (
      <>
        {unauthenticatedFallback ?? (
          <div className="flex flex-col items-center gap-4 p-8">
            <p>Please sign in to continue</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <SignInButton />
              <SignInButton provider="github" variant="outline" />
            </div>
          </div>
        )}
      </>
    );
  }

  return <>{children}</>;
}
