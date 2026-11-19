import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";

export async function GET() {
  try {
    const users = await db.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      success: true,
      data: users,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch staff directory";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, name, password, role, creatorId } = body;

    if (!email || !name || !password || !role) {
      return NextResponse.json(
        { success: false, error: "Name, email, password, and role are all required." },
        { status: 400 }
      );
    }

    const normalizedRole = role.toUpperCase();
    if (normalizedRole !== "ADMIN" && normalizedRole !== "WAREHOUSE") {
      return NextResponse.json(
        { success: false, error: "Only 'ADMIN' and 'WAREHOUSE' roles can be provisioned by Super Admin." },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existing = await db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      return NextResponse.json(
        { success: false, error: `A user with email '${normalizedEmail}' already exists.` },
        { status: 409 }
      );
    }

    // Persist new staff user in SQLite
    const newUser = await db.user.create({
      data: {
        email: normalizedEmail,
        name: name.trim(),
        passwordHash: password, // In production, hash with bcrypt/argon2
        role: normalizedRole,
      },
    });

    // Write record to the immutable audit trail
    await createAuditLog({
      entityType: "SECURITY",
      entityId: newUser.id,
      action: "STAFF_USER_PROVISIONED",
      actorRole: "ADMIN",
      actorId: creatorId || null,
      newState: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
      },
      metadata: {
        provisionedRole: newUser.role,
        provisionedBy: creatorId || "SUPER_ADMIN",
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: `Successfully provisioned ${newUser.role}: ${newUser.name} (${newUser.email})`,
        data: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
          createdAt: newUser.createdAt,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error creating staff user";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}