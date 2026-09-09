import { AuthConfigurationError, getAuth } from "@foundry/auth";

function configurationErrorResponse(error: AuthConfigurationError): Response {
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

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return Response.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "A valid session is required.",
          },
        },
        { status: 401 },
      );
    }

    return Response.json({
      data: {
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
        session: {
          id: session.session.id,
          expiresAt: session.session.expiresAt,
        },
      },
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return configurationErrorResponse(error);
    }

    throw error;
  }
}
