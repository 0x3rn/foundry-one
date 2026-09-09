import {
  AuthConfigurationError,
  createPrismaWorkspaceRepository,
  createWorkspace,
  getAuth,
  WorkspaceInputError,
} from "@foundry/auth";
import { getDatabaseClient } from "@foundry/database";

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

function unauthenticatedResponse(): Response {
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

async function getSession(request: Request) {
  return getAuth().api.getSession({
    headers: request.headers,
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getSession(request);

    if (!session) {
      return unauthenticatedResponse();
    }

    const workspaces = await getDatabaseClient().workspace.findMany({
      where: {
        members: {
          some: {
            userId: session.user.id,
          },
        },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        organizationId: true,
        members: {
          where: { userId: session.user.id },
          select: { role: true },
          take: 1,
        },
      },
    });

    return Response.json({
      data: workspaces.map(({ members, ...workspace }) => ({
        ...workspace,
        role: members[0]?.role ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return configurationErrorResponse(error);
    }

    throw error;
  }
}

function parseWorkspaceBody(value: unknown): { name: string; slug?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceInputError("Workspace input must be a JSON object.");
  }

  const body = value as Record<string, unknown>;

  if (typeof body.name !== "string") {
    throw new WorkspaceInputError("Workspace name must be a string.");
  }

  if (body.slug !== undefined && typeof body.slug !== "string") {
    throw new WorkspaceInputError("Workspace slug must be a string when provided.");
  }

  return {
    name: body.name,
    slug: body.slug as string | undefined,
  };
}

function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

  if (!slug) {
    throw new WorkspaceInputError("Workspace name must contain letters or numbers.");
  }

  return slug;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getSession(request);

    if (!session) {
      return unauthenticatedResponse();
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Request body must be valid JSON.",
          },
        },
        { status: 400 },
      );
    }

    const input = parseWorkspaceBody(body);
    const workspaceSlug = input.slug ?? slugFromName(input.name);
    const workspace = await createWorkspace(
      createPrismaWorkspaceRepository(getDatabaseClient()),
      session.user.id,
      {
        organizationName: `${input.name} Organization`,
        organizationSlug: `${workspaceSlug}-organization`,
        workspaceName: input.name,
        workspaceSlug,
      },
    );

    return Response.json({ data: workspace }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return configurationErrorResponse(error);
    }

    if (error instanceof WorkspaceInputError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: 400 },
      );
    }

    throw error;
  }
}
