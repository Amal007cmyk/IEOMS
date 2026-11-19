import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";
export async function GET(req: NextRequest){
try {

    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const entityType = searchParams.get("entityType");

    const whereClause: { entityType?: string } = {};
    if (entityType && entityType !== "ALL") {
      whereClause.entityType = entityType;
    }

    const logs = await db.auditLog.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, email: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({ success: true, count: logs.length, data: logs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch audit logs";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
