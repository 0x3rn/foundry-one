import { toNextJsHandler } from "better-auth/next-js";
import { AuthConfigurationError, getAuth } from "@foundry/auth";

function createHandler(method: "GET" | "POST") {
  return async (request: Request) => {
    try {
      const handlers = toNextJsHandler(getAuth());
      return method === "GET" ? handlers.GET(request) : handlers.POST(request);
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        return Response.json(
          {
            error: {
              code: error.code,
              message: error.message,
            },
          },
          { status: 503 },
        );
      }

      throw error;
    }
  };
}

export const GET = createHandler("GET");
export const POST = createHandler("POST");
