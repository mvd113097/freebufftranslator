/**
 * Node-runtime helper that decompresses gzip text produced by the app before
 * upload. It lives in its own `"use node"` file because `zlib` is a Node.js
 * built-in — the rest of the backend stays in Convex's default runtime.
 *
 * The pipeline action (translation.ts) calls this via `ctx.runAction` only for
 * chunks whose `originalGzip` flag is set, so legacy/plain chunks never pass
 * through here.
 */
"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { gunzipSync } from "zlib";

export const gunzipTexts = internalAction({
  args: {
    items: v.array(v.object({ data: v.string() })),
  },
  handler: async (_ctx, args) => {
    return args.items.map(({ data }) =>
      gunzipSync(Buffer.from(data, "base64")).toString("utf8")
    );
  },
});
