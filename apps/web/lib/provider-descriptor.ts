import { z } from "zod";

export const compatibleModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
});

export const compatibleModelDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive(),
  description: z.string().optional(),
  enabled: z.boolean(),
  capabilities: compatibleModelCapabilitiesSchema,
});

export type CompatibleModelDescriptor = z.infer<
  typeof compatibleModelDescriptorSchema
>;
