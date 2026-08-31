import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ─── Translation Jobs ────────────────────────────────────────
    translationJobs: defineTable({
      userId: v.optional(v.string()),
      fileName: v.string(),
      rawTextLength: v.number(),
      totalChunks: v.number(),
      status: v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("paused"),
        v.literal("completed"),
        v.literal("failed")
      ),
      model: v.string(),
      chunkSize: v.number(),
      concurrency: v.number(),
      apiKeys: v.array(v.string()),
      completedCount: v.number(),
      failedCount: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),

    translationChunks: defineTable({
      jobId: v.id("translationJobs"),
      chunkIndex: v.number(),
      originalText: v.string(),
      translatedText: v.string(),
      status: v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed")
      ),
      error: v.optional(v.string()),
      retries: v.number(),
    }).index("by_jobId", ["jobId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
