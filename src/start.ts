import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "./integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
  // Client middleware: attaches the signed-in user's JWT (Bearer token) to every
  // serverFn RPC so server functions can run as the authenticated user. Safe to
  // enable now — it attaches nothing when there is no session, so unauthenticated
  // calls behave exactly as before under the current using(true) policies.
  functionMiddleware: [attachSupabaseAuth],
}));
