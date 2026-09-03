import { NextRequest, NextResponse } from "next/server";
import { jsonError, jsonData, jsonValidationError } from "@/lib/conductor/server/response";
import { proxyToLaravel } from "@/lib/conductor/server/proxy";

const API_URL = process.env.API_URL || "http://localhost:8000";
const API_V1 = "/api/v1";

async function streamFromLaravel(request: NextRequest, path: string) {
  const token = request.cookies.get("chatco_session")?.value;
  if (!token) return jsonError("Unauthorized. Admin session required.", 401);

  try {
    const response = await fetch(`${API_URL}${API_V1}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "image/*" },
    });

    if (!response.ok) {
      return jsonError(
        response.status === 404 ? "License image not found." : "Failed to load license image.",
        response.status
      );
    }

    return new NextResponse(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return jsonError("Unable to reach the backend service. Please try again.", 502);
  }
}

/** GET /api/admin/drivers/{id}/license-images/{side} */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; side: string }> }
) {
  const { id, side } = await params;
  if (!id || !side || id === "undefined") return jsonError("License image path is invalid.", 400);
  return streamFromLaravel(request, `/admin/drivers/${id}/license-images/${side}`);
}

/** DELETE /api/admin/drivers/{id}/license-images/{side} */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; side: string }> }
) {
  const { id, side } = await params;
  if (!id || !side || id === "undefined") return jsonError("License image path is invalid.", 400);

  const result = await proxyToLaravel(request, `/admin/drivers/${id}/license-images/${side}`, {
    method: "DELETE",
  });
  if (!result.ok) {
    if (result.status === 422) {
      return jsonValidationError(result.message ?? "Validation failed.", result.errors, 422);
    }
    return jsonError(result.message ?? "Failed to remove license image.", result.status);
  }
  return jsonData(result.data);
}
