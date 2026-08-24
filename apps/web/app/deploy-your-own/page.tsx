import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { buildDeployTemplateUrl } from "@/lib/deployment/deploy-template";

const DEPLOY_TEMPLATE_URL = buildDeployTemplateUrl();

export const metadata: Metadata = {
  title: "Deploy your own",
  description:
    "Deploy your own copy of Open Agents to unlock the full template.",
};

export default function DeployYourOwnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-24 text-foreground">
      <div className="flex max-w-xl flex-col items-center text-center">
        <p className="text-sm font-medium text-muted-foreground">Open Agents</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">
          Deploy your own
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          This hosted demo has limited functionality. Deploy your own copy to
          unlock the full Open Agents template.
        </p>
        <Button asChild className="mt-8" size="lg">
          <Link href={DEPLOY_TEMPLATE_URL} rel="noreferrer" target="_blank">
            Deploy your own version of this template now
          </Link>
        </Button>
      </div>
    </main>
  );
}
