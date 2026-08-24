"use client";

import { Loader2 } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { GitHubIcon } from "./hero-icons";

function VercelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 1L24 22H0L12 1Z" />
    </svg>
  );
}

/**
 * Social providers configured in `lib/auth/config.ts`. Account linking is
 * enabled for both, so signing in with either provider resolves to the same
 * user when the accounts share an identity.
 */
export type SignInProvider = "vercel" | "github";

const PROVIDER_LABEL: Record<SignInProvider, string> = {
  vercel: "Vercel",
  github: "GitHub",
};

function ProviderIcon({ provider }: { provider: SignInProvider }) {
  return provider === "github" ? <GitHubIcon /> : <VercelIcon />;
}

function resolveRedirectPath(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return window.location.pathname + window.location.search;
  }

  return window.location.pathname + window.location.search;
}

type SignInButtonProps = {
  callbackUrl?: string;
  provider?: SignInProvider;
} & Omit<ComponentProps<typeof Button>, "onClick">;

export function SignInButton({
  callbackUrl,
  disabled,
  provider = "vercel",
  ...props
}: SignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  function handleSignIn() {
    if (disabled || isLoading) {
      return;
    }

    const fallback = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const redirectPath = resolveRedirectPath(callbackUrl ?? fallback);

    setIsLoading(true);
    authClient.signIn.social({
      provider,
      callbackURL: redirectPath,
    });
  }

  return (
    <Button
      {...props}
      aria-busy={isLoading}
      disabled={disabled || isLoading}
      onClick={handleSignIn}
    >
      {isLoading ? (
        <Loader2 className="animate-spin" />
      ) : (
        <ProviderIcon provider={provider} />
      )}
      {isLoading ? "Signing in..." : `Sign in with ${PROVIDER_LABEL[provider]}`}
    </Button>
  );
}
