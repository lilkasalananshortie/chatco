import { NextRequest } from "next/server";
import { proxyToLaravel, API_V1 } from "@/lib/commuter/server/proxy";

/**
 * GET /api/commuter/share-ride
 * The commuter's live link, or null. Never creates one.
 *
 * POST /api/commuter/share-ride
 * Creates (or refreshes) a tracking link for the commuter.
 *
 * DELETE /api/commuter/share-ride
 * Deactivates the commuter's active share link.
 */
export async function GET(request: NextRequest) {
  return proxyToLaravel(request, `${API_V1}/commuter/share-ride`, { method: "GET" });
}

export async function POST(request: NextRequest) {
  return proxyToLaravel(request, `${API_V1}/commuter/share-ride`, {
    method: "POST",
    body: await request.text(),
  });
}

export async function DELETE(request: NextRequest) {
  return proxyToLaravel(request, `${API_V1}/commuter/share-ride`, {
    method: "DELETE",
  });
}
