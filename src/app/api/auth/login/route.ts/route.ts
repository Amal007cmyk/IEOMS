New-Item -ItemType Directory -Force -Path "src\app\api\auth\login"

@'
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";

interface LoginRequestBody {
  email?: string;
  password?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: LoginRequestBody = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: "Both email and password are required." },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
    });

    const isValidTestPassword = password === "password123";

    if (!user || !isValidTestPassword) {
      await createAuditLog({
        entityType: "SECURITY",
        entityId: normalizedEmail,
        action: "LOGIN_FAILED_BAD_CREDENTIALS",
        actorRole: "SYSTEM",
        metadata: {
          attemptedEmail: normalizedEmail,
          ip: req.headers.get("x-forwarded-for") || "127.0.0.1",
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: "Invalid email or password. (Default seed password is 'password123')",
        },
        { status: 401 }
      );
    }

    await createAuditLog({
      entityType: "SECURITY",
      entityId: user.id,
      action: "USER_LOGIN_SUCCESS",
      actorRole: user.role as "ADMIN" | "WAREHOUSE" | "CUSTOMER",
      actorId: user.id,
      metadata: {
        email: user.email,
        role: user.role,
      },
    });

    const userSession = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    const response = NextResponse.json({
      success: true,
      message: `Successfully authenticated as ${user.role}`,
      user: userSession,
    });

    response.cookies.set({
      name: "auth_session",
      value: JSON.stringify(userSession),
      httpOnly: false,
      path: "/",
      maxAge: 60 * 60 * 24,
      sameSite: "lax",
    });

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Authentication error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
'@ | Set-Content -LiteralPath "src\app\api\auth\login\route.ts" -Encoding utf8
