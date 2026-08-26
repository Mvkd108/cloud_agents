import { getServerSession } from "@/lib/session/get-server-session";
import {
  getUserPreferences,
  type DiffMode,
  updateUserPreferences,
} from "@/lib/db/user-preferences";
import { sanitizeUserPreferencesForSession } from "@/lib/model-access";
import type { SandboxType } from "@/components/sandbox-selector-compact";
import {
  getSandboxProviderPolicy,
  isSandboxProviderEnabled,
} from "@/lib/sandbox/provider-policy";
import {
  globalSkillRefsSchema,
  type GlobalSkillRef,
} from "@/lib/skills/global-skill-refs";

/**
 * Sandbox providers the deployment currently exposes. Vercel is always
 * available; E2B only when the launch flag and credentials are configured.
 */
function getAvailableSandboxTypes(): SandboxType[] {
  const policy = getSandboxProviderPolicy();
  return policy.e2b.ready ? ["vercel", "e2b"] : ["vercel"];
}

interface UpdatePreferencesRequest {
  defaultModelId?: string;
  defaultSubagentModelId?: string | null;
  defaultSandboxType?: SandboxType;
  defaultDiffMode?: DiffMode;
  autoCommitPush?: boolean;
  autoCreatePr?: boolean;
  alertsEnabled?: boolean;
  alertSoundEnabled?: boolean;
  publicUsageEnabled?: boolean;
  globalSkillRefs?: GlobalSkillRef[];
  enabledModelIds?: string[];
}

export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const preferences = sanitizeUserPreferencesForSession(
    await getUserPreferences(session.user.id),
    session,
    req.url,
  );
  return Response.json({
    preferences,
    availableSandboxTypes: getAvailableSandboxTypes(),
  });
}

export async function PATCH(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: UpdatePreferencesRequest;
  try {
    body = (await req.json()) as UpdatePreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: UpdatePreferencesRequest = {};

  if (body.defaultSandboxType !== undefined) {
    const validTypes = ["vercel", "e2b"];
    if (
      typeof body.defaultSandboxType !== "string" ||
      !validTypes.includes(body.defaultSandboxType)
    ) {
      return Response.json({ error: "Invalid sandbox type" }, { status: 400 });
    }
    if (body.defaultSandboxType === "e2b" && !isSandboxProviderEnabled("e2b")) {
      return Response.json(
        { error: "The E2B sandbox provider is not enabled on this deployment" },
        { status: 400 },
      );
    }
    updates.defaultSandboxType = body.defaultSandboxType;
  }

  if (body.defaultDiffMode !== undefined) {
    const validDiffModes = ["unified", "split"];
    if (
      typeof body.defaultDiffMode !== "string" ||
      !validDiffModes.includes(body.defaultDiffMode)
    ) {
      return Response.json({ error: "Invalid diff mode" }, { status: 400 });
    }
    updates.defaultDiffMode = body.defaultDiffMode;
  }

  if (body.defaultModelId !== undefined) {
    if (typeof body.defaultModelId !== "string") {
      return Response.json(
        { error: "Invalid defaultModelId" },
        { status: 400 },
      );
    }
    updates.defaultModelId = body.defaultModelId;
  }

  if (body.defaultSubagentModelId !== undefined) {
    if (
      body.defaultSubagentModelId !== null &&
      typeof body.defaultSubagentModelId !== "string"
    ) {
      return Response.json(
        { error: "Invalid defaultSubagentModelId" },
        { status: 400 },
      );
    }
    updates.defaultSubagentModelId = body.defaultSubagentModelId;
  }

  if (
    body.autoCommitPush !== undefined &&
    typeof body.autoCommitPush !== "boolean"
  ) {
    return Response.json(
      { error: "Invalid autoCommitPush value" },
      { status: 400 },
    );
  }
  if (body.autoCommitPush !== undefined) {
    updates.autoCommitPush = body.autoCommitPush;
  }

  if (
    body.autoCreatePr !== undefined &&
    typeof body.autoCreatePr !== "boolean"
  ) {
    return Response.json(
      { error: "Invalid autoCreatePr value" },
      { status: 400 },
    );
  }
  if (body.autoCreatePr !== undefined) {
    updates.autoCreatePr = body.autoCreatePr;
  }

  if (
    body.alertsEnabled !== undefined &&
    typeof body.alertsEnabled !== "boolean"
  ) {
    return Response.json(
      { error: "Invalid alertsEnabled value" },
      { status: 400 },
    );
  }
  if (body.alertsEnabled !== undefined) {
    updates.alertsEnabled = body.alertsEnabled;
  }

  if (
    body.alertSoundEnabled !== undefined &&
    typeof body.alertSoundEnabled !== "boolean"
  ) {
    return Response.json(
      { error: "Invalid alertSoundEnabled value" },
      { status: 400 },
    );
  }
  if (body.alertSoundEnabled !== undefined) {
    updates.alertSoundEnabled = body.alertSoundEnabled;
  }

  if (
    body.publicUsageEnabled !== undefined &&
    typeof body.publicUsageEnabled !== "boolean"
  ) {
    return Response.json(
      { error: "Invalid publicUsageEnabled value" },
      { status: 400 },
    );
  }
  if (body.publicUsageEnabled !== undefined) {
    updates.publicUsageEnabled = body.publicUsageEnabled;
  }

  if (body.globalSkillRefs !== undefined) {
    const parsedGlobalSkillRefs = globalSkillRefsSchema.safeParse(
      body.globalSkillRefs,
    );
    if (!parsedGlobalSkillRefs.success) {
      return Response.json(
        { error: "Invalid globalSkillRefs value" },
        { status: 400 },
      );
    }
    updates.globalSkillRefs = parsedGlobalSkillRefs.data;
  }

  if (body.enabledModelIds !== undefined) {
    if (
      !Array.isArray(body.enabledModelIds) ||
      !body.enabledModelIds.every((id) => typeof id === "string")
    ) {
      return Response.json(
        { error: "Invalid enabledModelIds value" },
        { status: 400 },
      );
    }
    updates.enabledModelIds = body.enabledModelIds;
  }

  try {
    const preferences = sanitizeUserPreferencesForSession(
      await updateUserPreferences(session.user.id, updates),
      session,
      req.url,
    );
    return Response.json({
      preferences,
      availableSandboxTypes: getAvailableSandboxTypes(),
    });
  } catch (error) {
    console.error("Failed to update preferences:", error);
    return Response.json(
      { error: "Failed to update preferences" },
      { status: 500 },
    );
  }
}
